import { createHash } from 'node:crypto';
import {
  auth,
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type OAuthClientProvider,
  type Tool as McpSdkTool
} from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { z } from 'zod';
import type {
  McpServerConfig,
  McpServerStatus,
  Tool,
  ToolResult
} from '@desktop-agent/contracts';
import { DesktopMcpOAuthProvider, type McpOAuthCredentials } from './mcp-oauth.js';

const CONNECT_TIMEOUT_MS = 15_000;
const MAX_EAGER_TOOLS = 24;
const MAX_SEARCH_RESULTS = 12;
const SearchInput = z.object({ query: z.string().trim().max(500).default('') });

export type McpClientConnection = {
  listTools(): Promise<{ tools: McpSdkTool[] }>;
  callTool(name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult>;
  close(): Promise<void>;
  instructions?: string;
};

export type McpConnectionFactory = (config: McpServerConfig, authProvider?: OAuthClientProvider) => Promise<McpClientConnection>;

export type McpOAuthCallbacks = {
  onAuthorization(requestId: string, url: string): void;
  onCredentials(serverId: string, credentials: McpOAuthCredentials): void;
};

function connectionError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}

async function defaultConnectionFactory(config: McpServerConfig, authProvider?: OAuthClientProvider): Promise<McpClientConnection> {
  const client = new Client(
    { name: 'desktop-agent', version: '0.1.0' },
    {
      versionNegotiation: {
        mode: config.transport === 'streamable_http' ? config.versionNegotiation : 'auto'
      }
    }
  );
  const transport = config.transport === 'stdio'
    ? new StdioClientTransport({
        command: config.command,
        args: config.args,
        ...(config.cwd ? { cwd: config.cwd } : {}),
        ...(config.env ? { env: { ...getDefaultEnvironment(), ...config.env } } : {}),
        stderr: 'pipe'
      })
    : new StreamableHTTPClientTransport(new URL(config.url), {
        ...(config.headers ? { requestInit: { headers: config.headers } } : {}),
        ...(authProvider ? { authProvider } : {})
      });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('MCP connection timed out.')), CONNECT_TIMEOUT_MS);
  try {
    await client.connect(transport, { signal: controller.signal, timeout: CONNECT_TIMEOUT_MS });
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const instructions = client.getInstructions();
  return {
    listTools: () => client.listTools(),
    callTool: (name, input, signal) => client.callTool({ name, arguments: input }, { signal }),
    close: () => client.close(),
    ...(instructions ? { instructions } : {})
  };
}

function exposedName(serverId: string, toolName: string): string {
  const raw = `mcp__${serverId}__${toolName}`;
  const safe = raw.replace(/[^a-zA-Z0-9_-]/gu, '_');
  if (safe === raw && safe.length <= 64) return safe;
  const suffix = createHash('sha256').update(raw).digest('hex').slice(0, 8);
  return `${safe.slice(0, 55)}_${suffix}`;
}

function resultText(result: CallToolResult): string {
  const parts = result.content.map((block) => {
    if (block.type === 'text') return block.text;
    if (block.type === 'resource_link') return `[resource ${block.name}: ${block.uri}]`;
    if (block.type === 'resource') {
      const resource = block.resource;
      return 'text' in resource ? resource.text : `[binary resource: ${resource.uri}]`;
    }
    if (block.type === 'image') return `[image: ${block.mimeType}, ${block.data.length} base64 characters]`;
    if (block.type === 'audio') return `[audio: ${block.mimeType}, ${block.data.length} base64 characters]`;
    return JSON.stringify(block);
  });
  if (result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent, null, 2));
  return parts.filter(Boolean).join('\n').slice(0, 1_000_000) || '(MCP tool returned no content)';
}

type ToolEntry = {
  serverId: string;
  remoteName: string;
  exposedName: string;
  searchText: string;
  tool: Tool;
};

function createToolEntry(server: McpServerConfig, sdkTool: McpSdkTool, connection: McpClientConnection): ToolEntry {
  const name = exposedName(server.id, sdkTool.name);
  const description = `[MCP: ${server.name}] ${sdkTool.description ?? sdkTool.title ?? sdkTool.name}`;
  const schema = sdkTool.inputSchema && typeof sdkTool.inputSchema === 'object'
    ? sdkTool.inputSchema as Record<string, unknown>
    : { type: 'object' };
  const tool: Tool = {
    definition: { name, description, inputSchema: schema },
    async execute(input, context): Promise<ToolResult> {
      const argumentsValue = input && typeof input === 'object' && !Array.isArray(input)
        ? input as Record<string, unknown>
        : {};
      const result = await connection.callTool(sdkTool.name, argumentsValue, context.signal);
      return {
        callId: '',
        ok: result.isError !== true,
        content: resultText(result),
        ...(result.isError === true ? { code: 'mcp_tool_error' } : {})
      };
    }
  };
  return {
    serverId: server.id,
    remoteName: sdkTool.name,
    exposedName: name,
    searchText: `${server.name} ${sdkTool.name} ${sdkTool.title ?? ''} ${sdkTool.description ?? ''}`.toLowerCase(),
    tool
  };
}

export class McpManager {
  private connections: McpClientConnection[] = [];
  private entries: ToolEntry[] = [];
  private activated = new Set<string>();
  private statuses: McpServerStatus[] = [];
  private configs: McpServerConfig[] = [];
  private oauthCredentials: Record<string, McpOAuthCredentials> = {};
  private pendingOAuth = new Map<string, { serverId: string; provider: DesktopMcpOAuthProvider }>();

  constructor(
    private readonly onStatus: (statuses: McpServerStatus[]) => void = () => undefined,
    private readonly connectionFactory: McpConnectionFactory = defaultConnectionFactory,
    private readonly oauthCallbacks: McpOAuthCallbacks = {
      onAuthorization: () => undefined,
      onCredentials: () => undefined
    }
  ) {}

  getStatuses(): McpServerStatus[] { return this.statuses.map((status) => ({ ...status })); }

  async configure(configs: McpServerConfig[], oauthCredentials: Record<string, McpOAuthCredentials> = {}): Promise<void> {
    await this.close();
    this.configs = configs;
    this.oauthCredentials = oauthCredentials;
    this.entries = [];
    this.activated.clear();
    this.statuses = configs.map((config) => ({
      serverId: config.id,
      name: config.name,
      state: config.enabled ? 'connecting' : 'disabled',
      toolCount: 0
    }));
    this.notify();
    await Promise.all(configs.map(async (config, index) => {
      if (!config.enabled) return;
      const oauth = config.transport === 'streamable_http' && config.auth?.type === 'oauth';
      const credentials = oauth ? this.oauthCredentials[config.id] : undefined;
      if (oauth && !credentialsHaveTokens(credentials)) {
        this.statuses[index] = {
          serverId: config.id, name: config.name, state: 'auth_required', toolCount: 0, authType: 'oauth'
        };
        this.notify();
        return;
      }
      let connection: McpClientConnection | undefined;
      try {
        const authProvider = oauth && credentials?.redirectUrl
          ? this.createOAuthProvider(config.id, credentials.redirectUrl, crypto.randomUUID(), config.auth?.scopes, config.auth?.resourceOrigins, credentials)
          : undefined;
        let connectionConfig = config;
        if (config.transport === 'streamable_http' && authProvider && credentials?.discoveryState?.resourceMetadata?.resource) {
          const canonicalUrl = await authProvider.validateResourceURL?.(
            config.url,
            credentials.discoveryState.resourceMetadata.resource
          );
          if (canonicalUrl) connectionConfig = { ...config, url: canonicalUrl.toString() };
        }
        const connected = await this.connectionFactory(connectionConfig, authProvider);
        connection = connected;
        const { tools } = await connected.listTools();
        this.connections.push(connected);
        this.entries.push(...tools.map((tool) => createToolEntry(config, tool, connected)));
        this.statuses[index] = {
          serverId: config.id, name: config.name, state: 'connected', toolCount: tools.length,
          ...(oauth ? { authType: 'oauth' as const } : {})
        };
      } catch (error) {
        await connection?.close().catch(() => undefined);
        this.statuses[index] = {
          serverId: config.id,
          name: config.name,
          state: 'error',
          toolCount: 0,
          ...(oauth ? { authType: 'oauth' as const } : {}),
          error: connectionError(error)
        };
      }
      this.notify();
    }));
  }

  async startOAuth(serverId: string, requestId: string, redirectUrl: string, state: string): Promise<'pending' | 'complete'> {
    const config = this.configs.find((item) => item.id === serverId);
    if (!config || config.transport !== 'streamable_http' || config.auth?.type !== 'oauth') {
      throw new Error(`MCP server “${serverId}” is not configured for OAuth.`);
    }
    const index = this.configs.findIndex((item) => item.id === serverId);
    this.statuses[index] = { serverId, name: config.name, state: 'authorizing', toolCount: 0, authType: 'oauth' };
    this.notify();
    const stored = this.oauthCredentials[serverId];
    const credentials = stored?.redirectUrl && stored.redirectUrl !== redirectUrl
      ? { ...stored, redirectUrl, clients: {}, tokens: {} }
      : stored;
    const provider = this.createOAuthProvider(serverId, redirectUrl, state, config.auth.scopes, config.auth.resourceOrigins, credentials, requestId);
    this.pendingOAuth.set(requestId, { serverId, provider });
    try {
      const result = await auth(provider, {
        serverUrl: config.url,
        ...(config.auth.scopes?.length ? { scope: config.auth.scopes.join(' ') } : {})
      });
      if (result !== 'REDIRECT') {
        await this.finishOAuthSuccess(requestId);
        return 'complete';
      }
      return 'pending';
    } catch (error) {
      this.failOAuth(requestId, serverId, config.name, error);
      throw error;
    }
  }

  async finishOAuth(requestId: string, serverId: string, callbackParams: URLSearchParams): Promise<void> {
    const pending = this.pendingOAuth.get(requestId);
    const config = this.configs.find((item) => item.id === serverId);
    if (!pending || pending.serverId !== serverId || !config || config.transport !== 'streamable_http') {
      throw new Error('OAuth authorization session is no longer active.');
    }
    const error = callbackParams.get('error');
    if (error) throw new Error(callbackParams.get('error_description') || `OAuth authorization failed: ${error}`);
    const code = callbackParams.get('code');
    if (!code) throw new Error('OAuth callback did not include an authorization code.');
    try {
      const result = await auth(pending.provider, {
        serverUrl: config.url,
        authorizationCode: code,
        ...(callbackParams.get('iss') ? { iss: callbackParams.get('iss')! } : {}),
        ...(config.auth?.scopes?.length ? { scope: config.auth.scopes.join(' ') } : {})
      });
      if (result !== 'AUTHORIZED') throw new Error('OAuth authorization did not complete.');
      await this.finishOAuthSuccess(requestId);
    } catch (error) {
      this.failOAuth(requestId, serverId, config.name, error);
      throw error;
    }
  }

  async disconnectOAuth(serverId: string): Promise<void> {
    delete this.oauthCredentials[serverId];
    this.oauthCallbacks.onCredentials(serverId, {});
    await this.configure(this.configs, this.oauthCredentials);
  }

  private async finishOAuthSuccess(requestId: string): Promise<void> {
    this.pendingOAuth.delete(requestId);
    await this.configure(this.configs, this.oauthCredentials);
  }

  private failOAuth(requestId: string, serverId: string, name: string, error: unknown): void {
    this.pendingOAuth.delete(requestId);
    const index = this.configs.findIndex((item) => item.id === serverId);
    if (index >= 0) {
      this.statuses[index] = {
        serverId, name, state: 'error', toolCount: 0, authType: 'oauth', error: connectionError(error)
      };
      this.notify();
    }
  }

  private createOAuthProvider(
    serverId: string,
    redirectUrl: string,
    state: string,
    scopes: string[] | undefined,
    resourceOrigins: string[] | undefined,
    credentials: McpOAuthCredentials | undefined,
    requestId?: string
  ): DesktopMcpOAuthProvider {
    return new DesktopMcpOAuthProvider({
      redirectUrl, state,
      ...(scopes ? { scopes } : {}),
      ...(resourceOrigins ? { resourceOrigins } : {}),
      ...(credentials ? { credentials } : {}),
      onChanged: (next) => {
        this.oauthCredentials[serverId] = next;
        this.oauthCallbacks.onCredentials(serverId, next);
      },
      onAuthorization: (url) => {
        if (!requestId) throw new Error('MCP OAuth credentials expired; reconnect the account.');
        this.oauthCallbacks.onAuthorization(requestId, url.toString());
      }
    });
  }

  getTools(): Tool[] {
    if (this.entries.length <= MAX_EAGER_TOOLS) return this.entries.map((entry) => entry.tool);
    const active = this.entries.filter((entry) => this.activated.has(entry.exposedName)).map((entry) => entry.tool);
    return [this.createSearchTool(), ...active];
  }

  private createSearchTool(): Tool {
    return {
      definition: {
        name: 'mcp_search_tools',
        description: `Search and activate tools from the connected MCP catalog (${this.entries.length} tools). Use this before calling an MCP tool that is not currently visible.`,
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string', description: 'Keywords describing the capability needed.' } },
          additionalProperties: false
        }
      },
      execute: async (input) => {
        const { query } = SearchInput.parse(input);
        const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
        const matches = this.entries
          .map((entry) => ({ entry, score: terms.reduce((score, term) => score + (entry.searchText.includes(term) ? 1 : 0), 0) }))
          .filter(({ score }) => terms.length === 0 || score > 0)
          .sort((left, right) => right.score - left.score || left.entry.exposedName.localeCompare(right.entry.exposedName))
          .slice(0, MAX_SEARCH_RESULTS)
          .map(({ entry }) => entry);
        for (const entry of matches) this.activated.add(entry.exposedName);
        const content = matches.length > 0
          ? `Activated MCP tools for the next model step:\n${matches.map((entry) => `- ${entry.exposedName}: ${entry.tool.definition.description}`).join('\n')}`
          : 'No matching MCP tools found. Try broader keywords.';
        return { callId: '', ok: true, content };
      }
    };
  }

  async close(): Promise<void> {
    const connections = this.connections.splice(0);
    await Promise.allSettled(connections.map((connection) => connection.close()));
  }

  private notify(): void { this.onStatus(this.getStatuses()); }
}

function credentialsHaveTokens(credentials: McpOAuthCredentials | undefined): boolean {
  return Boolean(credentials?.tokens && Object.keys(credentials.tokens).length > 0 && credentials.redirectUrl);
}
