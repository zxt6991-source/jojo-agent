import type {
  OAuthClientInformationContext,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens
} from '@modelcontextprotocol/client';
import { checkResourceAllowed } from '@modelcontextprotocol/client';

export type McpOAuthCredentials = {
  redirectUrl?: string;
  latestIssuer?: string;
  clients?: Record<string, StoredOAuthClientInformation>;
  tokens?: Record<string, StoredOAuthTokens>;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
};

export type McpOAuthProviderOptions = {
  redirectUrl: string;
  state: string;
  scopes?: string[];
  resourceOrigins?: string[];
  credentials?: McpOAuthCredentials;
  onChanged(credentials: McpOAuthCredentials): void;
  onAuthorization(url: URL): void;
};

export class DesktopMcpOAuthProvider implements OAuthClientProvider {
  private credentials: McpOAuthCredentials;

  constructor(private readonly options: McpOAuthProviderOptions) {
    this.credentials = { ...options.credentials, redirectUrl: options.redirectUrl };
  }

  get redirectUrl(): string { return this.options.redirectUrl; }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.options.redirectUrl],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'Desktop Agent',
      ...(this.options.scopes?.length ? { scope: this.options.scopes.join(' ') } : {})
    };
  }

  state(): string { return this.options.state; }

  clientInformation(context?: OAuthClientInformationContext): StoredOAuthClientInformation | undefined {
    const issuer = context?.issuer ?? this.credentials.latestIssuer;
    return issuer ? this.credentials.clients?.[issuer] : undefined;
  }

  saveClientInformation(value: StoredOAuthClientInformation, context?: OAuthClientInformationContext): void {
    const issuer = context?.issuer ?? value.issuer;
    if (!issuer) throw new Error('OAuth client registration did not include an issuer.');
    this.credentials = {
      ...this.credentials,
      latestIssuer: issuer,
      clients: { ...this.credentials.clients, [issuer]: value }
    };
    this.changed();
  }

  tokens(context?: OAuthClientInformationContext): StoredOAuthTokens | undefined {
    const issuer = context?.issuer ?? this.credentials.latestIssuer;
    return issuer ? this.credentials.tokens?.[issuer] : undefined;
  }

  saveTokens(value: StoredOAuthTokens, context?: OAuthClientInformationContext): void {
    const issuer = context?.issuer ?? value.issuer;
    if (!issuer) throw new Error('OAuth token response did not include an issuer.');
    this.credentials = {
      ...this.credentials,
      latestIssuer: issuer,
      tokens: { ...this.credentials.tokens, [issuer]: value }
    };
    this.changed();
  }

  redirectToAuthorization(url: URL): void { this.options.onAuthorization(url); }

  saveCodeVerifier(codeVerifier: string): void {
    this.credentials = { ...this.credentials, codeVerifier };
    this.changed();
  }

  codeVerifier(): string {
    if (!this.credentials.codeVerifier) throw new Error('OAuth PKCE verifier is unavailable.');
    return this.credentials.codeVerifier;
  }

  async validateResourceURL(serverUrl: string | URL, resource?: string): Promise<URL | undefined> {
    if (!resource) return undefined;
    const expected = new URL(serverUrl);
    const declared = new URL(resource);
    if (checkResourceAllowed({ requestedResource: expected, configuredResource: declared })) return declared;

    const discovery = this.credentials.discoveryState;
    const metadataResource = discovery?.resourceMetadata?.resource;
    const metadataUrl = discovery?.resourceMetadataUrl ? new URL(discovery.resourceMetadataUrl) : undefined;
    const allowedOrigins = new Set(this.options.resourceOrigins?.map((origin) => new URL(origin).origin));
    const metadataOriginMatches = !metadataUrl
      || (metadataUrl.protocol === 'https:' && metadataUrl.origin === declared.origin);
    const trustedCanonical = expected.protocol === 'https:'
      && declared.protocol === 'https:'
      && allowedOrigins.has(declared.origin)
      && metadataResource === declared.toString()
      && metadataOriginMatches;
    if (!trustedCanonical) {
      throw new Error(`Protected resource ${declared} does not match expected ${expected} or a trusted canonical resource.`);
    }
    return declared;
  }

  saveDiscoveryState(discoveryState: OAuthDiscoveryState): void {
    this.credentials = { ...this.credentials, discoveryState };
    this.changed();
  }

  discoveryState(): OAuthDiscoveryState | undefined { return this.credentials.discoveryState; }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all') this.credentials = { redirectUrl: this.options.redirectUrl };
    else {
      const next = { ...this.credentials };
      if (scope === 'client') delete next.clients;
      else if (scope === 'tokens') delete next.tokens;
      else if (scope === 'verifier') delete next.codeVerifier;
      else delete next.discoveryState;
      this.credentials = next;
    }
    this.changed();
  }

  snapshot(): McpOAuthCredentials { return structuredClone(this.credentials); }

  private changed(): void { this.options.onChanged(this.snapshot()); }
}
