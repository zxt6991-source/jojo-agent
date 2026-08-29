import { createHash } from 'node:crypto';
import {
  auth,
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type ContentBlock as McpContentBlock,
  type GetPromptResult,
  type ListResourceTemplatesResult,
  type Prompt,
  type ReadResourceResult,
  type Resource,
  type OAuthClientProvider,
  type Tool as McpSdkTool
} from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createProcessSandbox, type ProcessSandbox } from '@desktop-agent/process-sandbox';
import { z } from 'zod';
import type {
  McpServerConfig,
  McpServerStatus,
  McpTrustStore,
  SecretBroker,
  SecurityApprovalPreview,
  Tool,
  ToolCall,
  ToolResult
} from '@desktop-agent/contracts';
import { DesktopMcpOAuthProvider, type McpOAuthCredentials } from './mcp-oauth.js';
import { McpResultNormalizer } from './mcp-security/result-normalizer.js';
import { mcpServerFingerprint, type McpFingerprintResult } from './mcp-security/fingerprint.js';
import { mcpStdioSandboxSpec, SandboxedStdioTransport } from './mcp-security/sandboxed-stdio.js';
import { createSafeMcpFetch, McpHttpTargetPolicy } from './mcp-security/http-target-policy.js';
import { EnvironmentSecretBroker, resolveMcpConfigValues } from './mcp-security/secret-broker.js';

const CONNECT_TIMEOUT_MS = 15_000;
const TOOL_CATALOG_CONTEXT_RATIO = 0.08;
const CONNECT_RETRY_DELAYS_MS = [250, 750] as const;
const MCP_INSTRUCTION_MAX_BYTES = 8 * 1024;
const resultNormalizer = new McpResultNormalizer();
const ManifestInput = z.object({
  query: z.string().trim().max(500).default(''),
  serverId: z.string().trim().max(64).optional()
});
const ToolNameInput = z.object({ name: z.string().trim().min(1).max(128) });
const ToolCallInput = ToolNameInput.extend({ arguments: z.record(z.string(), z.unknown()).default({}) });
const ResourceInput = z.object({ serverId: z.string().trim().min(1).max(64), uri: z.string().min(1).max(16_384) });
const PromptInput = z.object({
  serverId: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(500),
  arguments: z.record(z.string(), z.string()).default({})
});

type McpSessionState = { sessionId?: string; protocolVersion?: string; configSignature: string };
type McpResourceTemplate = ListResourceTemplatesResult['resourceTemplates'][number];
type McpResumableSession = { sessionId?: string; protocolVersion?: string };

export type McpConnectionEvents = {
  onToolsChanged?(error: Error | null, tools: McpSdkTool[] | null): void;
  onResourcesChanged?(error: Error | null, resources: Resource[] | null): void;
  onPromptsChanged?(error: Error | null, prompts: Prompt[] | null): void;
};

export type McpConnectionOptions = {
  events?: McpConnectionEvents;
  session?: McpSessionState;
  processSandbox?: ProcessSandbox;
  secretBroker?: SecretBroker;
  httpTargetPolicy?: McpHttpTargetPolicy;
};

export type McpClientConnection = {
  listTools(): Promise<{ tools: McpSdkTool[] }>;
  callTool(name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult>;
  listResources?(): Promise<{ resources: Resource[] }>;
  listResourceTemplates?(): Promise<{ resourceTemplates: McpResourceTemplate[] }>;
  readResource?(uri: string, signal: AbortSignal): Promise<ReadResourceResult>;
  listPrompts?(): Promise<{ prompts: Prompt[] }>;
  getPrompt?(name: string, input: Record<string, string>, signal: AbortSignal): Promise<GetPromptResult>;
  getSessionState?(): McpResumableSession;
  close(): Promise<void>;
  instructions?: string;
};

export type McpConnectionFactory = (
  config: McpServerConfig,
  authProvider?: OAuthClientProvider,
  options?: McpConnectionOptions
) => Promise<McpClientConnection>;

export type McpOAuthCallbacks = {
  onAuthorization(requestId: string, url: string): void;
  onCredentials(serverId: string, credentials: McpOAuthCredentials): void;
};

export type McpManagerOptions = {
  trustStore?: McpTrustStore;
  enforceStdioSandbox?: boolean;
  secretBroker?: SecretBroker;
  httpTargetPolicy?: McpHttpTargetPolicy;
};

function connectionError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}

async function defaultConnectionFactory(
  config: McpServerConfig,
  authProvider?: OAuthClientProvider,
  options: McpConnectionOptions = {}
): Promise<McpClientConnection> {
  const secretBroker = options.secretBroker ?? new EnvironmentSecretBroker();
  const httpTargetPolicy = options.httpTargetPolicy ?? new McpHttpTargetPolicy();
  const httpTarget = config.transport === 'streamable_http'
    ? await httpTargetPolicy.validate(config.url, { allowPrivate: config.security?.network === 'private' })
    : undefined;
  const leases: Array<{ dispose(): void }> = [];
  const env = config.transport === 'stdio'
    ? await resolveMcpConfigValues(config.env, secretBroker, `MCP stdio ${config.id}`, (name) => /(?:^|_)(?:API_?KEY|AUTH(?:ORIZATION)?|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_?KEY|ACCESS_?KEY)(?:_|$)/iu.test(name))
    : undefined;
  if (env) leases.push(env);
  const headers = config.transport === 'streamable_http'
    ? await resolveMcpConfigValues(config.headers, secretBroker, `MCP HTTP ${config.id}`, (name) => /^(?:authorization|cookie|proxy-authorization|x-api-key|x-auth-token)$/iu.test(name))
    : undefined;
  if (headers) leases.push(headers);
  const client = new Client(
    { name: 'desktop-agent', version: '0.1.0' },
    {
      versionNegotiation: {
        mode: config.transport === 'streamable_http' ? config.versionNegotiation : 'auto'
      },
      listChanged: {
        tools: { onChanged: (error, tools) => options.events?.onToolsChanged?.(error, tools) },
        resources: { onChanged: (error, resources) => options.events?.onResourcesChanged?.(error, resources) },
        prompts: { onChanged: (error, prompts) => options.events?.onPromptsChanged?.(error, prompts) }
      }
    }
  );
  let transport: SandboxedStdioTransport | StdioClientTransport | StreamableHTTPClientTransport;
  try {
    transport = config.transport === 'stdio'
      ? options.processSandbox
        ? new SandboxedStdioTransport(options.processSandbox, mcpStdioSandboxSpec(config, env?.values))
        : new StdioClientTransport({
          command: config.command,
          args: config.args,
          ...(config.cwd ? { cwd: config.cwd } : {}),
          ...(env ? { env: { ...getDefaultEnvironment(), ...env.values } } : {}),
          stderr: 'pipe'
          })
      : new StreamableHTTPClientTransport(httpTarget!, {
          ...(headers ? { requestInit: { headers: headers.values } } : {}),
          fetch: createSafeMcpFetch(httpTargetPolicy, { allowPrivate: config.security?.network === 'private' }),
          ...(authProvider ? { authProvider } : {}),
          ...(options.session?.sessionId ? { sessionId: options.session.sessionId } : {}),
          ...(options.session?.protocolVersion ? { protocolVersion: options.session.protocolVersion } : {}),
          reconnectionOptions: {
            initialReconnectionDelay: 500,
            maxReconnectionDelay: 5_000,
            reconnectionDelayGrowFactor: 2,
            maxRetries: 3
          }
        });
  } catch (error) {
    leases.forEach((lease) => lease.dispose());
    throw error;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('MCP connection timed out.')), CONNECT_TIMEOUT_MS);
  try {
    await client.connect(transport, { signal: controller.signal, timeout: CONNECT_TIMEOUT_MS });
  } catch (error) {
    await client.close().catch(() => undefined);
    leases.forEach((lease) => lease.dispose());
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const instructions = client.getInstructions();
  return {
    listTools: () => client.listTools(),
    callTool: (name, input, signal) => client.callTool({ name, arguments: input }, { signal }),
    listResources: () => client.listResources(),
    listResourceTemplates: () => client.listResourceTemplates(),
    readResource: (uri, signal) => client.readResource({ uri }, { signal }),
    listPrompts: () => client.listPrompts(),
    getPrompt: (name, input, signal) => client.getPrompt({ name, arguments: input }, { signal }),
    getSessionState: () => {
      const sessionId = transport instanceof StreamableHTTPClientTransport ? transport.sessionId : undefined;
      const protocolVersion = client.getNegotiatedProtocolVersion();
      return {
        ...(sessionId ? { sessionId } : {}),
        ...(protocolVersion ? { protocolVersion } : {})
      };
    },
    close: async () => { try { await client.close(); } finally { leases.forEach((lease) => lease.dispose()); } },
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

function mcpContentResult(result: Pick<CallToolResult, 'content' | 'structuredContent' | 'isError'>): ToolResult {
  return resultNormalizer.normalize(result);
}

type ToolEntry = {
  serverId: string;
  remoteName: string;
  exposedName: string;
  searchText: string;
  tool: Tool;
  readOnlyHint: boolean;
  trustedRead: boolean;
};

function createToolEntry(
  server: McpServerConfig,
  sdkTool: McpSdkTool,
  allowTrustedRead: boolean,
  call: (serverId: string, name: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<ToolResult>
): ToolEntry {
  const name = exposedName(server.id, sdkTool.name);
  const description = `[MCP: ${server.name}] ${sdkTool.description ?? sdkTool.title ?? sdkTool.name}`;
  const readOnlyHint = sdkTool.annotations?.readOnlyHint === true;
  const trustedRead = allowTrustedRead && readOnlyHint && (server.security?.trustedReadTools ?? []).includes(sdkTool.name);
  const schema = sdkTool.inputSchema && typeof sdkTool.inputSchema === 'object'
    ? sdkTool.inputSchema as Record<string, unknown>
    : { type: 'object' };
  const tool: Tool = {
    replay: 'never',
    risk: trustedRead ? 'read' : 'external_side_effect',
    definition: { name, description, inputSchema: schema },
    async execute(input, context): Promise<ToolResult> {
      const argumentsValue = input && typeof input === 'object' && !Array.isArray(input)
        ? input as Record<string, unknown>
        : {};
      return call(server.id, sdkTool.name, argumentsValue, context.signal);
    }
  };
  return {
    serverId: server.id,
    remoteName: sdkTool.name,
    exposedName: name,
    searchText: `${server.name} ${sdkTool.name} ${sdkTool.title ?? ''} ${sdkTool.description ?? ''}`.toLowerCase(),
    tool,
    readOnlyHint,
    trustedRead
  };
}

function estimatedDefinitionTokens(tool: Tool): number {
  const serialized = `${tool.definition.name}\n${tool.definition.description}\n${JSON.stringify(tool.definition.inputSchema)}`;
  let ascii = 0;
  for (const character of serialized) if (character.charCodeAt(0) <= 0x7f) ascii += 1;
  return Math.ceil(ascii / 4 + (serialized.length - ascii) * 1.25) + 16;
}

function configSignature(config: McpServerConfig): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

function retryableConnectionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? String(error.code) : '';
  if (['CONNECTION_CLOSED', 'SEND_FAILED', 'REQUEST_TIMEOUT', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE'].includes(code)) return true;
  const status = 'status' in error && typeof error.status === 'number' ? error.status : undefined;
  return status === 408 || status === 429 || (status !== undefined && status >= 500);
}

async function retryDelay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export class McpManager {
  private connections = new Map<string, McpClientConnection>();
  private entries: ToolEntry[] = [];
  private resources = new Map<string, Resource[]>();
  private resourceTemplates = new Map<string, McpResourceTemplate[]>();
  private prompts = new Map<string, Prompt[]>();
  private sessions = new Map<string, McpSessionState>();
  private statuses: McpServerStatus[] = [];
  private configs: McpServerConfig[] = [];
  private oauthCredentials: Record<string, McpOAuthCredentials> = {};
  private pendingOAuth = new Map<string, { serverId: string; provider: DesktopMcpOAuthProvider }>();
  private fingerprints = new Map<string, McpFingerprintResult>();
  private trustedServers = new Set<string>();

  constructor(
    private readonly onStatus: (statuses: McpServerStatus[]) => void = () => undefined,
    private readonly connectionFactory: McpConnectionFactory = defaultConnectionFactory,
    private readonly oauthCallbacks: McpOAuthCallbacks = {
      onAuthorization: () => undefined,
      onCredentials: () => undefined
    },
    private readonly security: McpManagerOptions = {}
  ) {}

  getStatuses(): McpServerStatus[] { return this.statuses.map((status) => ({ ...status })); }

  describeApproval(call: ToolCall): SecurityApprovalPreview | undefined {
    const input = call.input && typeof call.input === 'object' && !Array.isArray(call.input)
      ? call.input as Record<string, unknown>
      : {};
    const exposedName = call.name === 'mcp_tool_call' && typeof input.name === 'string' ? input.name : call.name;
    const entry = this.entries.find((candidate) => candidate.exposedName === exposedName);
    const serverId = entry?.serverId ?? (typeof input.serverId === 'string' ? input.serverId : undefined);
    const config = serverId ? this.configs.find((candidate) => candidate.id === serverId) : undefined;
    if (!serverId || !config) return undefined;
    const reasons = ['MCP tool metadata and output are controlled by the external server.'];
    if (entry?.trustedRead) reasons.push('Local policy explicitly trusts this read-only tool and the server reports readOnlyHint=true.');
    else if (entry?.readOnlyHint) reasons.push('The server reports readOnlyHint=true; this is an untrusted hint and does not bypass approval.');
    if (config.security?.workspaceAccess && config.security.workspaceAccess !== 'none') {
      reasons.push(`Server workspace access: ${config.security.workspaceAccess}.`);
    }
    if (config.security?.network && config.security.network !== 'none') reasons.push(`Server network access: ${config.security.network}.`);
    return {
      kind: 'mcp', serverId, serverName: config.name,
      toolName: entry?.remoteName ?? call.name,
      risk: entry?.trustedRead ? 'read' : 'external_side_effect',
      capabilities: this.fingerprints.get(serverId)?.capabilities ?? [],
      reasons
    };
  }

  approvalGrantKey(call: ToolCall): string | undefined {
    const input = call.input && typeof call.input === 'object' && !Array.isArray(call.input)
      ? call.input as Record<string, unknown>
      : {};
    const exposedName = call.name === 'mcp_tool_call' && typeof input.name === 'string' ? input.name : call.name;
    const entry = this.entries.find((candidate) => candidate.exposedName === exposedName);
    const fingerprint = entry ? this.fingerprints.get(entry.serverId)?.fingerprint : undefined;
    return entry && fingerprint
      ? `mcp:${createHash('sha256').update(JSON.stringify([entry.serverId, fingerprint, entry.exposedName])).digest('hex')}`
      : undefined;
  }

  async configure(configs: McpServerConfig[], oauthCredentials: Record<string, McpOAuthCredentials> = {}): Promise<void> {
    await this.close();
    this.configs = configs;
    this.oauthCredentials = oauthCredentials;
    this.entries = [];
    this.resources.clear();
    this.resourceTemplates.clear();
    this.prompts.clear();
    this.fingerprints.clear();
    this.trustedServers.clear();
    for (const [serverId, session] of this.sessions) {
      const config = configs.find((item) => item.id === serverId);
      if (!config || session.configSignature !== configSignature(config)) this.sessions.delete(serverId);
    }
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
      try {
        if (!await this.isTrusted(config)) {
          this.statuses[index] = this.trustRequiredStatus(config, oauth);
          return;
        }
        const credentials = oauth ? this.oauthCredentials[config.id] : undefined;
        if (oauth && !credentialsHaveTokens(credentials)) {
          this.statuses[index] = {
            serverId: config.id, name: config.name, state: 'auth_required', toolCount: 0, authType: 'oauth',
            ...this.statusFingerprint(config.id)
          };
          return;
        }
        await this.connectServer(config, index, oauth, credentials);
      } catch (error) {
        this.statuses[index] = {
          serverId: config.id,
          name: config.name,
          state: 'error',
          toolCount: 0,
          ...(oauth ? { authType: 'oauth' as const } : {}),
          ...this.statusFingerprint(config.id),
          error: connectionError(error)
        };
      }
      this.notify();
    }));
  }

  async reconnect(serverId?: string): Promise<void> {
    const targets = this.configs.filter((config) => config.enabled && (!serverId || config.id === serverId));
    if (serverId && targets.length === 0) throw new Error(`MCP server “${serverId}” is not enabled or does not exist.`);
    await Promise.all(targets.map(async (config) => {
      const index = this.configs.findIndex((item) => item.id === config.id);
      const existing = this.connections.get(config.id);
      if (existing) {
        const state = existing.getSessionState?.();
        if (state) this.sessions.set(config.id, { ...state, configSignature: configSignature(config) });
        this.connections.delete(config.id);
        await existing.close().catch(() => undefined);
      }
      this.entries = this.entries.filter((entry) => entry.serverId !== config.id);
      this.resources.delete(config.id);
      this.resourceTemplates.delete(config.id);
      this.prompts.delete(config.id);
      this.statuses[index] = {
        serverId: config.id, name: config.name, state: 'connecting', toolCount: 0,
        ...(config.transport === 'streamable_http' && config.auth?.type === 'oauth' ? { authType: 'oauth' as const } : {})
      };
      this.notify();
      const oauth = config.transport === 'streamable_http' && config.auth?.type === 'oauth';
      try {
        if (!await this.isTrusted(config)) {
          this.statuses[index] = this.trustRequiredStatus(config, oauth);
          this.notify();
          return;
        }
        const credentials = this.oauthCredentials[config.id];
        if (oauth && !credentialsHaveTokens(credentials)) {
          this.statuses[index] = {
            serverId: config.id, name: config.name, state: 'auth_required', toolCount: 0, authType: 'oauth',
            ...this.statusFingerprint(config.id)
          };
          this.notify();
          return;
        }
        await this.connectServer(config, index, oauth, credentials);
      } catch (error) {
        this.statuses[index] = {
          serverId: config.id, name: config.name, state: 'error', toolCount: 0,
          ...(oauth ? { authType: 'oauth' as const } : {}), ...this.statusFingerprint(config.id), error: connectionError(error)
        };
      }
      this.notify();
    }));
  }

  private async connectServer(
    config: McpServerConfig,
    statusIndex: number,
    oauth: boolean,
    credentials: McpOAuthCredentials | undefined
  ): Promise<void> {
    const authProvider = oauth && credentials?.redirectUrl
      ? this.createOAuthProvider(config.id, credentials.redirectUrl, crypto.randomUUID(), config.transport === 'streamable_http' ? config.auth?.scopes : undefined, config.transport === 'streamable_http' ? config.auth?.resourceOrigins : undefined, credentials)
      : undefined;
    let connectionConfig = config;
    if (config.transport === 'streamable_http' && authProvider && credentials?.discoveryState?.resourceMetadata?.resource) {
      const canonicalUrl = await authProvider.validateResourceURL?.(config.url, credentials.discoveryState.resourceMetadata.resource);
      if (canonicalUrl) connectionConfig = { ...config, url: canonicalUrl.toString() };
    }
    const events: McpConnectionEvents = {
      onToolsChanged: (error, tools) => {
        if (!error && tools) this.replaceTools(config, tools);
      },
      onResourcesChanged: (error, resources) => {
        if (!error && resources) {
          this.resources.set(config.id, resources);
          void this.refreshResourceTemplates(config.id);
          this.updateConnectedStatus(config.id);
        }
      },
      onPromptsChanged: (error, prompts) => {
        if (!error && prompts) {
          this.prompts.set(config.id, prompts);
          this.updateConnectedStatus(config.id);
        }
      }
    };
    let connected: McpClientConnection | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt <= CONNECT_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        const session = this.sessions.get(config.id);
        connected = await this.connectionFactory(connectionConfig, authProvider, {
          events,
          ...(config.transport === 'stdio' && this.security.enforceStdioSandbox
            ? { processSandbox: createProcessSandbox(config.security?.sandboxMode ?? 'fallback') }
            : {}),
          ...(this.security.secretBroker ? { secretBroker: this.security.secretBroker } : {}),
          ...(this.security.httpTargetPolicy ? { httpTargetPolicy: this.security.httpTargetPolicy } : {}),
          ...(session ? { session } : {})
        });
        break;
      } catch (error) {
        lastError = error;
        if (!retryableConnectionError(error) || attempt >= CONNECT_RETRY_DELAYS_MS.length) throw error;
        await retryDelay(CONNECT_RETRY_DELAYS_MS[attempt]!);
      }
    }
    if (!connected) throw lastError;
    try {
      const [{ tools }, resourceResult, templateResult, promptResult] = await Promise.all([
        connected.listTools(),
        connected.listResources?.().catch(() => ({ resources: [] })),
        connected.listResourceTemplates?.().catch(() => ({ resourceTemplates: [] })),
        connected.listPrompts?.().catch(() => ({ prompts: [] }))
      ]);
      this.connections.set(config.id, connected);
      this.replaceTools(config, tools);
      this.resources.set(config.id, resourceResult?.resources ?? []);
      this.resourceTemplates.set(config.id, templateResult?.resourceTemplates ?? []);
      this.prompts.set(config.id, promptResult?.prompts ?? []);
      const session = connected.getSessionState?.();
      if (session) this.sessions.set(config.id, { ...session, configSignature: configSignature(config) });
      this.statuses[statusIndex] = {
        serverId: config.id, name: config.name, state: 'connected', toolCount: tools.length,
        ...this.statusFingerprint(config.id),
        ...((resourceResult?.resources.length ?? 0) + (templateResult?.resourceTemplates.length ?? 0) > 0
          ? { resourceCount: (resourceResult?.resources.length ?? 0) + (templateResult?.resourceTemplates.length ?? 0) }
          : {}),
        ...(promptResult?.prompts.length ? { promptCount: promptResult.prompts.length } : {}),
        ...(oauth ? { authType: 'oauth' as const } : {})
      };
    } catch (error) {
      await connected.close().catch(() => undefined);
      throw error;
    }
  }

  private replaceTools(config: McpServerConfig, tools: McpSdkTool[]): void {
    this.entries = this.entries.filter((entry) => entry.serverId !== config.id);
    this.entries.push(...tools.map((tool) => createToolEntry(
      config,
      tool,
      this.trustedServers.has(config.id),
      (serverId, name, input, signal) => this.callRemoteTool(serverId, name, input, signal)
    )));
    this.updateConnectedStatus(config.id);
  }

  private async refreshResourceTemplates(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId);
    if (!connection?.listResourceTemplates) return;
    try {
      const { resourceTemplates } = await connection.listResourceTemplates();
      this.resourceTemplates.set(serverId, resourceTemplates);
      this.updateConnectedStatus(serverId);
    } catch { /* A list_changed refresh failure leaves the previous manifest intact. */ }
  }

  private updateConnectedStatus(serverId: string): void {
    const index = this.statuses.findIndex((status) => status.serverId === serverId);
    if (index < 0 || this.statuses[index]?.state !== 'connected') return;
    const status = this.statuses[index]!;
    const baseStatus = { ...status };
    delete baseStatus.resourceCount;
    delete baseStatus.promptCount;
    const resourceCount = (this.resources.get(serverId)?.length ?? 0) + (this.resourceTemplates.get(serverId)?.length ?? 0);
    const promptCount = this.prompts.get(serverId)?.length ?? 0;
    this.statuses[index] = {
      ...baseStatus,
      toolCount: this.entries.filter((entry) => entry.serverId === serverId).length,
      ...(resourceCount > 0 ? { resourceCount } : {}),
      ...(promptCount > 0 ? { promptCount } : {})
    };
    this.notify();
  }

  async startOAuth(serverId: string, requestId: string, redirectUrl: string, state: string): Promise<'pending' | 'complete'> {
    const config = this.configs.find((item) => item.id === serverId);
    if (!config || config.transport !== 'streamable_http' || config.auth?.type !== 'oauth') {
      throw new Error(`MCP server “${serverId}” is not configured for OAuth.`);
    }
    if (!await this.isTrusted(config)) throw new Error(`mcp_trust_required: MCP server “${serverId}” must be trusted before OAuth.`);
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
      const targetPolicy = this.security.httpTargetPolicy ?? new McpHttpTargetPolicy();
      const fetchFn = createSafeMcpFetch(targetPolicy, { allowPrivate: config.security?.network === 'private' });
      const result = await auth(provider, {
        serverUrl: config.url,
        fetchFn,
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
      const targetPolicy = this.security.httpTargetPolicy ?? new McpHttpTargetPolicy();
      const fetchFn = createSafeMcpFetch(targetPolicy, { allowPrivate: config.security?.network === 'private' });
      const result = await auth(pending.provider, {
        serverUrl: config.url,
        authorizationCode: code,
        fetchFn,
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

  getTools(context: { contextWindowTokens?: number; maxOutputTokens?: number } = {}): Tool[] {
    const contextWindowTokens = context.contextWindowTokens ?? 128_000;
    const maxOutputTokens = context.maxOutputTokens ?? 8_192;
    const availableInputTokens = Math.max(1_024, contextWindowTokens - maxOutputTokens);
    const catalogThreshold = Math.max(512, Math.floor(availableInputTokens * TOOL_CATALOG_CONTEXT_RATIO));
    const definitionTokens = this.entries.reduce((sum, entry) => sum + estimatedDefinitionTokens(entry.tool), 0);
    const toolAccess = definitionTokens <= catalogThreshold
      ? this.entries.map((entry) => entry.tool)
      : [this.createManifestTool(), this.createDescribeTool(), this.createCallTool()];
    return [
      ...toolAccess,
      ...([...this.resources.values(), ...this.resourceTemplates.values()].some((items) => items.length > 0)
        ? [this.createListResourcesTool(), this.createReadResourceTool()] : []),
      ...([...this.prompts.values()].some((items) => items.length > 0)
        ? [this.createListPromptsTool(), this.createGetPromptTool()] : [])
    ];
  }

  getInstructions(): string[] {
    return this.configs.flatMap((config) => {
      if (config.security?.allowInstructions !== true) return [];
      const instructions = this.connections.get(config.id)?.instructions?.trim();
      if (!instructions) return [];
      const bounded = Buffer.from(instructions, 'utf8').subarray(0, MCP_INSTRUCTION_MAX_BYTES).toString('utf8');
      return [`Untrusted MCP server “${config.name}” instructions:\n${bounded}`];
    });
  }

  private createManifestTool(): Tool {
    return {
      replay: 'safe',
      definition: {
        name: 'mcp_tool_manifest',
        description: `Search the compact manifest of ${this.entries.length} connected MCP tools. Use mcp_tool_describe before mcp_tool_call when arguments are unclear.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Optional capability keywords; omit to list the full manifest.' },
            serverId: { type: 'string', description: 'Optional MCP server id.' }
          },
          additionalProperties: false
        }
      },
      execute: async (input) => {
        const { query, serverId } = ManifestInput.parse(input);
        const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
        const matches = this.entries
          .filter((entry) => !serverId || entry.serverId === serverId)
          .map((entry) => ({ entry, score: terms.reduce((score, term) => score + (entry.searchText.includes(term) ? 1 : 0), 0) }))
          .filter(({ score }) => terms.length === 0 || score > 0)
          .sort((left, right) => right.score - left.score || left.entry.exposedName.localeCompare(right.entry.exposedName));
        const content = matches.length > 0
          ? matches.map(({ entry }) => `- ${entry.exposedName}: ${entry.tool.definition.description}`).join('\n')
          : 'No matching MCP tools found. Try broader keywords.';
        return { callId: '', ok: true, content };
      }
    };
  }

  private createDescribeTool(): Tool {
    return {
      replay: 'safe',
      definition: {
        name: 'mcp_tool_describe',
        description: 'Return the full description and input schema for one tool from mcp_tool_manifest.',
        inputSchema: {
          type: 'object', required: ['name'], additionalProperties: false,
          properties: { name: { type: 'string', description: 'Exact manifest tool name.' } }
        }
      },
      execute: async (input) => {
        const { name } = ToolNameInput.parse(input);
        const entry = this.entries.find((item) => item.exposedName === name);
        if (!entry) return { callId: '', ok: false, code: 'mcp_tool_not_found', content: `Unknown MCP tool: ${name}` };
        return {
          callId: '', ok: true,
          content: JSON.stringify({ name, description: entry.tool.definition.description, inputSchema: entry.tool.definition.inputSchema }, null, 2)
        };
      }
    };
  }

  private createCallTool(): Tool {
    return {
      replay: 'never',
      risk: 'external_side_effect',
      definition: {
        name: 'mcp_tool_call',
        description: 'Call one MCP tool by its exact manifest name. This is an external action and requires approval.',
        inputSchema: {
          type: 'object', required: ['name'], additionalProperties: false,
          properties: {
            name: { type: 'string', description: 'Exact tool name returned by mcp_tool_manifest.' },
            arguments: { type: 'object', description: 'Arguments matching mcp_tool_describe.', additionalProperties: true }
          }
        }
      },
      execute: async (input, context) => {
        const parsed = ToolCallInput.parse(input);
        const entry = this.entries.find((item) => item.exposedName === parsed.name);
        if (!entry) return { callId: '', ok: false, code: 'mcp_tool_not_found', content: `Unknown MCP tool: ${parsed.name}` };
        return this.callRemoteTool(entry.serverId, entry.remoteName, parsed.arguments, context.signal);
      }
    };
  }

  private createListResourcesTool(): Tool {
    return {
      replay: 'safe',
      definition: {
        name: 'mcp_list_resources',
        description: 'List connected MCP resources and URI templates from the local manifest.',
        inputSchema: { type: 'object', additionalProperties: false }
      },
      execute: async () => {
        const content = this.configs.flatMap((config) => [
          ...(this.resources.get(config.id) ?? []).map((resource) => ({
            serverId: config.id, uri: resource.uri, name: resource.name,
            ...(resource.description ? { description: resource.description } : {}),
            ...(resource.mimeType ? { mimeType: resource.mimeType } : {})
          })),
          ...(this.resourceTemplates.get(config.id) ?? []).map((template) => ({
            serverId: config.id, uriTemplate: template.uriTemplate, name: template.name,
            ...(template.description ? { description: template.description } : {}),
            ...(template.mimeType ? { mimeType: template.mimeType } : {})
          }))
        ]);
        return { callId: '', ok: true, content: JSON.stringify(content, null, 2) };
      }
    };
  }

  private createReadResourceTool(): Tool {
    return {
      replay: 'safe',
      risk: 'external_side_effect',
      definition: {
        name: 'mcp_read_resource',
        description: 'Read one MCP resource by server id and URI. URI templates must be expanded first.',
        inputSchema: {
          type: 'object', required: ['serverId', 'uri'], additionalProperties: false,
          properties: { serverId: { type: 'string' }, uri: { type: 'string' } }
        }
      },
      execute: async (input, context) => {
        const { serverId, uri } = ResourceInput.parse(input);
        const connection = this.connections.get(serverId);
        if (!connection?.readResource) return { callId: '', ok: false, code: 'mcp_resources_unavailable', content: `MCP server “${serverId}” does not expose resources.` };
        const result = await connection.readResource(uri, context.signal);
        return mcpContentResult({
          content: result.contents.map((resource) => ({ type: 'resource' as const, resource })),
          isError: false
        });
      }
    };
  }

  private createListPromptsTool(): Tool {
    return {
      replay: 'safe',
      definition: {
        name: 'mcp_list_prompts',
        description: 'List connected MCP prompt templates from the local manifest.',
        inputSchema: { type: 'object', additionalProperties: false }
      },
      execute: async () => {
        const content = this.configs.flatMap((config) => (this.prompts.get(config.id) ?? []).map((prompt) => ({
          serverId: config.id, name: prompt.name,
          ...(prompt.description ? { description: prompt.description } : {}),
          ...(prompt.arguments ? { arguments: prompt.arguments } : {})
        })));
        return { callId: '', ok: true, content: JSON.stringify(content, null, 2) };
      }
    };
  }

  private createGetPromptTool(): Tool {
    return {
      replay: 'safe',
      risk: 'external_side_effect',
      definition: {
        name: 'mcp_get_prompt',
        description: 'Render an MCP prompt template with string arguments.',
        inputSchema: {
          type: 'object', required: ['serverId', 'name'], additionalProperties: false,
          properties: {
            serverId: { type: 'string' }, name: { type: 'string' },
            arguments: { type: 'object', additionalProperties: { type: 'string' } }
          }
        }
      },
      execute: async (input, context) => {
        const parsed = PromptInput.parse(input);
        const connection = this.connections.get(parsed.serverId);
        if (!connection?.getPrompt) return { callId: '', ok: false, code: 'mcp_prompts_unavailable', content: `MCP server “${parsed.serverId}” does not expose prompts.` };
        const result = await connection.getPrompt(parsed.name, parsed.arguments, context.signal);
        const content: McpContentBlock[] = [];
        for (const message of result.messages) {
          const block = message.content;
          const prefix = { type: 'text' as const, text: `${message.role}:` };
          if (block.type === 'text') content.push({ type: 'text', text: `${message.role}: ${block.text}` });
          else if (block.type === 'image') content.push(prefix, block);
          else if (block.type === 'audio') content.push({ type: 'text', text: `${message.role}: [audio ${block.mimeType}, ${block.data.length} base64 characters]` });
          else if (block.type === 'resource_link') content.push({ type: 'text', text: `${message.role}: [resource ${block.name}: ${block.uri}]` });
          else if (block.type === 'resource') content.push(prefix, block);
          else content.push({ type: 'text', text: `${message.role}: ${JSON.stringify(block)}` });
        }
        if (result.description) content.unshift({ type: 'text' as const, text: result.description });
        return mcpContentResult({ content, isError: false });
      }
    };
  }

  private async callRemoteTool(serverId: string, name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
    const connection = this.connections.get(serverId);
    if (!connection) return { callId: '', ok: false, code: 'mcp_not_connected', content: `MCP server “${serverId}” is not connected.` };
    return mcpContentResult(await connection.callTool(name, input, signal));
  }

  async close(): Promise<void> {
    const connections = [...this.connections.entries()];
    this.connections.clear();
    for (const [serverId, connection] of connections) {
      const config = this.configs.find((item) => item.id === serverId);
      const state = connection.getSessionState?.();
      if (config && state) this.sessions.set(serverId, { ...state, configSignature: configSignature(config) });
    }
    await Promise.allSettled(connections.map(([, connection]) => connection.close()));
  }

  private notify(): void { this.onStatus(this.getStatuses()); }

  async trust(serverId: string, scope: 'user' | 'workspace' = 'user'): Promise<void> {
    if (!this.security.trustStore) throw new Error('mcp_trust_store_unavailable');
    const config = this.configs.find((item) => item.id === serverId && item.enabled);
    if (!config) throw new Error(`MCP server “${serverId}” is not enabled or does not exist.`);
    const current = await mcpServerFingerprint(config);
    this.fingerprints.set(serverId, current);
    await this.security.trustStore.trust({
      serverId, fingerprint: current.fingerprint, scope,
      capabilities: current.capabilities,
      allowInstructions: config.security?.allowInstructions ?? false,
      trustedAt: new Date().toISOString()
    });
    await this.reconnect(serverId);
  }

  async revokeTrust(serverId: string): Promise<void> {
    if (!this.security.trustStore) throw new Error('mcp_trust_store_unavailable');
    await this.security.trustStore.revoke(serverId);
    this.trustedServers.delete(serverId);
    const connection = this.connections.get(serverId);
    this.connections.delete(serverId);
    if (connection) await connection.close().catch(() => undefined);
    this.entries = this.entries.filter((entry) => entry.serverId !== serverId);
    this.resources.delete(serverId);
    this.resourceTemplates.delete(serverId);
    this.prompts.delete(serverId);
    const config = this.configs.find((item) => item.id === serverId);
    const index = this.statuses.findIndex((status) => status.serverId === serverId);
    if (config?.enabled && index >= 0) this.statuses[index] = this.trustRequiredStatus(config, config.transport === 'streamable_http' && config.auth?.type === 'oauth');
    this.notify();
  }

  private async isTrusted(config: McpServerConfig): Promise<boolean> {
    const current = await mcpServerFingerprint(config);
    this.fingerprints.set(config.id, current);
    if (!this.security.trustStore) return true;
    const grant = await this.security.trustStore.get(config.id);
    const trusted = grant?.fingerprint === current.fingerprint;
    if (trusted) this.trustedServers.add(config.id);
    else this.trustedServers.delete(config.id);
    return trusted;
  }

  private statusFingerprint(serverId: string): { fingerprint?: string } {
    if (!this.security.trustStore) return {};
    const fingerprint = this.fingerprints.get(serverId)?.fingerprint;
    return fingerprint ? { fingerprint } : {};
  }

  private trustRequiredStatus(config: McpServerConfig, oauth: boolean): McpServerStatus {
    return {
      serverId: config.id, name: config.name, state: 'trust_required', toolCount: 0,
      ...(oauth ? { authType: 'oauth' as const } : {}), ...this.statusFingerprint(config.id)
    };
  }
}

function credentialsHaveTokens(credentials: McpOAuthCredentials | undefined): boolean {
  return Boolean(credentials?.tokens && Object.keys(credentials.tokens).length > 0 && credentials.redirectUrl);
}
