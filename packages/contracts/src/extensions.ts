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

export const ExtensionSettingsSchema = z.object({
  mcpServers: z.array(McpServerConfigSchema).max(50).default([]),
  skills: z.object({
    directories: z.array(z.string().trim().min(1)).max(50).default([]),
    disabled: z.array(z.string().trim().min(1)).max(500).default([])
  }).default({ directories: [], disabled: [] })
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
  skills: { directories: [], disabled: [] }
};

export type McpConnectionState = 'disabled' | 'connecting' | 'auth_required' | 'authorizing' | 'connected' | 'error';
export type McpServerStatus = {
  serverId: string;
  name: string;
  state: McpConnectionState;
  toolCount: number;
  authType?: 'oauth';
  error?: string;
};

export type SkillStatus = {
  id: string;
  name: string;
  description: string;
  path: string;
  enabled: boolean;
  error?: string;
};

export type SkillDetail = SkillStatus & { content: string };

export type ExtensionStatus = {
  mcpServers: McpServerStatus[];
  skills: SkillStatus[];
};
