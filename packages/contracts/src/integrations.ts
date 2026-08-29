import { z } from 'zod';

const IdentifierSchema = z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/u);
export const SecretReferenceSchema = z.object({
  provider: z.enum(['desktop', 'env', 'keychain']),
  key: z.string().trim().min(1).max(512)
}).strict();
export type SecretReference = z.infer<typeof SecretReferenceSchema>;
export type SecretLease = { value: string; expiresAt?: number; dispose(): void };
export interface SecretBroker {
  resolve(reference: SecretReference, context: { purpose: string; sessionId?: string }): Promise<SecretLease>;
}
const McpConfigValueSchema = z.union([
  z.string(),
  z.object({ value: z.string() }).strict(),
  z.object({ secretRef: SecretReferenceSchema }).strict()
]);
const McpConfigMapSchema = z.record(z.string(), McpConfigValueSchema);
const SENSITIVE_ENV_NAME = /(?:^|_)(?:API_?KEY|AUTH(?:ORIZATION)?|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_?KEY|ACCESS_?KEY)(?:_|$)/iu;
const SENSITIVE_HEADER_NAME = /^(?:authorization|cookie|proxy-authorization|x-api-key|x-auth-token)$/iu;
function rejectLiteralSecrets(values: Record<string, z.infer<typeof McpConfigValueSchema>> | undefined, header: boolean, context: z.RefinementCtx): void {
  for (const [name, value] of Object.entries(values ?? {})) {
    const sensitive = header ? SENSITIVE_HEADER_NAME.test(name) : SENSITIVE_ENV_NAME.test(name);
    if (sensitive && (typeof value === 'string' || 'value' in value)) {
      context.addIssue({ code: 'custom', message: `Sensitive ${header ? 'header' : 'environment variable'} ${name} must use secretRef.` });
    }
  }
}
const McpSecuritySchema = z.object({
  workspaceAccess: z.enum(['none', 'read', 'write']).default('none'),
  network: z.enum(['none', 'outbound', 'private']).default('none'),
  allowInstructions: z.boolean().default(false),
  sandboxMode: z.enum(['strict', 'fallback']).default('fallback'),
  trustedReadTools: z.array(z.string().trim().min(1).max(128)).max(100).default([])
}).partial().optional();
const HttpsOriginSchema = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && url.href === `${url.origin}/`;
}, 'OAuth resource origin must be an HTTPS origin without a path, query, or fragment.');

export const McpStdioServerConfigSchema = z.object({
  id: IdentifierSchema,
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(true),
  transport: z.literal('stdio'),
  command: z.string().trim().min(1),
  args: z.array(z.string()).max(100).default([]),
  cwd: z.string().trim().min(1).optional(),
  env: McpConfigMapSchema.optional(),
  security: McpSecuritySchema
}).superRefine((config, context) => rejectLiteralSecrets(config.env, false, context));

export const McpHttpServerConfigSchema = z.object({
  id: IdentifierSchema,
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(true),
  transport: z.literal('streamable_http'),
  url: z.string().url().refine((value) => {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  }, 'MCP URL must use HTTPS (HTTP is only allowed for loopback) and cannot contain credentials.'),
  versionNegotiation: z.enum(['legacy', 'auto']).default('auto'),
  headers: McpConfigMapSchema.optional(),
  auth: z.object({
    type: z.literal('oauth'),
    scopes: z.array(z.string().trim().min(1)).max(50).optional(),
    resourceOrigins: z.array(HttpsOriginSchema).max(20).optional()
  }).optional(),
  security: McpSecuritySchema
}).superRefine((config, context) => rejectLiteralSecrets(config.headers, true, context));

export const McpServerConfigSchema = z.discriminatedUnion('transport', [
  McpStdioServerConfigSchema,
  McpHttpServerConfigSchema
]);
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const McpServerCapabilitySchema = z.enum([
  'workspace:read', 'workspace:write', 'network:outbound', 'network:private',
  'process:spawn', 'credential:secret', 'instructions:contribute'
]);
export type McpServerCapability = z.infer<typeof McpServerCapabilitySchema>;

export const McpTrustGrantSchema = z.object({
  serverId: IdentifierSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  scope: z.enum(['user', 'workspace']),
  capabilities: z.array(McpServerCapabilitySchema).max(20),
  allowInstructions: z.boolean(),
  trustedAt: z.string().datetime()
}).strict();
export type McpTrustGrant = z.infer<typeof McpTrustGrantSchema>;

export interface McpTrustStore {
  get(serverId: string): Promise<McpTrustGrant | undefined>;
  trust(grant: McpTrustGrant): Promise<void>;
  revoke(serverId: string): Promise<void>;
}

export const DEFAULT_BROWSER_SETTINGS = {
  enabled: true,
  allowedDomains: [] as string[],
  mode: 'sandbox' as const,
  chromeDebugPort: 9222,
  chromeNewTab: true
};

export const BrowserSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  allowedDomains: z.array(z.string().trim().min(1).max(253).regex(/^(?:\*\.)?[a-z0-9.-]+$/iu))
    .max(200)
    .default([]),
  mode: z.enum(['sandbox', 'chrome']).default('sandbox'),
  chromeDebugPort: z.number().int().min(1).max(65_535).default(9222),
  chromeNewTab: z.boolean().default(true)
});
export type BrowserSettings = z.infer<typeof BrowserSettingsSchema>;

/** Desktop integration settings. This is not the code-extension manifest contract. */
export const ExtensionSettingsSchema = z.object({
  mcpServers: z.array(McpServerConfigSchema).max(50).default([]),
  skills: z.object({
    directories: z.array(z.string().trim().min(1)).max(50).default([]),
    disabled: z.array(z.string().trim().min(1)).max(500).default([])
  }).default({ directories: [], disabled: [] }),
  browser: BrowserSettingsSchema.default(() => ({ ...DEFAULT_BROWSER_SETTINGS }))
}).superRefine((settings, context) => {
  const ids = new Set<string>();
  for (const server of settings.mcpServers) {
    if (ids.has(server.id)) context.addIssue({ code: 'custom', message: `Duplicate MCP server id: ${server.id}` });
    ids.add(server.id);
  }
});
export type ExtensionSettings = z.infer<typeof ExtensionSettingsSchema>;

export const DEFAULT_EXTENSION_SETTINGS: ExtensionSettings = {
  mcpServers: [],
  skills: { directories: [], disabled: [] },
  browser: { ...DEFAULT_BROWSER_SETTINGS }
};

export const McpConnectionStateSchema = z.enum(['disabled', 'trust_required', 'connecting', 'auth_required', 'authorizing', 'connected', 'error']);
export type McpConnectionState = z.infer<typeof McpConnectionStateSchema>;
export const McpServerStatusSchema = z.object({
  serverId: z.string().min(1).max(64), name: z.string().min(1).max(120), state: McpConnectionStateSchema,
  toolCount: z.number().int().nonnegative(), resourceCount: z.number().int().nonnegative().optional(),
  promptCount: z.number().int().nonnegative().optional(), authType: z.literal('oauth').optional(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  error: z.string().max(20_000).optional()
}).strict();
export type McpServerStatus = z.infer<typeof McpServerStatusSchema>;

export const SkillStatusSchema = z.object({
  id: z.string().min(1).max(256), name: z.string().min(1).max(120), description: z.string().max(4_000),
  path: z.string().min(1).max(4_096), rootPath: z.string().min(1).max(4_096),
  origin: z.enum(['project', 'user', 'custom', 'default']),
  resources: z.object({
    scripts: z.array(z.string().max(4_096)).max(1_000),
    templates: z.array(z.string().max(4_096)).max(1_000),
    references: z.array(z.string().max(4_096)).max(1_000)
  }).strict(),
  enabled: z.boolean(), error: z.string().max(20_000).optional(), overriddenBy: z.string().max(4_096).optional()
}).strict();
export type SkillStatus = z.infer<typeof SkillStatusSchema>;

export type SkillDetail = SkillStatus & { content: string };

export type SkillOperationResult = {
  canceled: boolean;
  path?: string;
};

export const ExtensionStatusSchema = z.object({
  mcpServers: z.array(McpServerStatusSchema).max(50),
  skills: z.array(SkillStatusSchema).max(2_000)
}).strict();
export type ExtensionStatus = z.infer<typeof ExtensionStatusSchema>;
