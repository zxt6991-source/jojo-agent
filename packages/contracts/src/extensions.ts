import { z } from 'zod';

const IdentifierSchema = z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/u);
const StringMapSchema = z.record(z.string(), z.string());
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
  env: StringMapSchema.optional()
});

export const McpHttpServerConfigSchema = z.object({
  id: IdentifierSchema,
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(true),
  transport: z.literal('streamable_http'),
  url: z.string().url().refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), 'MCP URL must use HTTP or HTTPS.'),
  versionNegotiation: z.enum(['legacy', 'auto']).default('auto'),
  headers: StringMapSchema.optional(),
  auth: z.object({
    type: z.literal('oauth'),
    scopes: z.array(z.string().trim().min(1)).max(50).optional(),
    resourceOrigins: z.array(HttpsOriginSchema).max(20).optional()
  }).optional()
});

export const McpServerConfigSchema = z.discriminatedUnion('transport', [
  McpStdioServerConfigSchema,
  McpHttpServerConfigSchema
]);
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

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

export const McpConnectionStateSchema = z.enum(['disabled', 'connecting', 'auth_required', 'authorizing', 'connected', 'error']);
export type McpConnectionState = z.infer<typeof McpConnectionStateSchema>;
export const McpServerStatusSchema = z.object({
  serverId: z.string().min(1).max(64), name: z.string().min(1).max(120), state: McpConnectionStateSchema,
  toolCount: z.number().int().nonnegative(), resourceCount: z.number().int().nonnegative().optional(),
  promptCount: z.number().int().nonnegative().optional(), authType: z.literal('oauth').optional(),
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
