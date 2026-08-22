import { z } from 'zod';
import { MessageSchema } from './messages';
import { ExtensionSettingsSchema, DEFAULT_BROWSER_SETTINGS } from './extensions';
import { DEFAULT_MEMORY_SETTINGS, MemorySettingsSchema, ProjectIdentitySchema } from './memory';

export const DEFAULT_SESSION_TITLE = '新会话';
export const SESSION_TITLE_MAX_LENGTH = 120;

export function projectNameFromDirectory(workingDirectory: string): string {
  return workingDirectory.split(/[\\/]/).filter(Boolean).pop() ?? workingDirectory;
}

export function isPlaceholderSessionTitle(title: string, workingDirectory: string): boolean {
  return title === DEFAULT_SESSION_TITLE || title === projectNameFromDirectory(workingDirectory);
}

export function sessionTitleFromPrompt(text: string): string {
  const normalized = text.trim().replace(/\s+/gu, ' ');
  let title = '';
  for (const character of normalized) {
    if (title.length + character.length > SESSION_TITLE_MAX_LENGTH) break;
    title += character;
  }
  return title;
}

export const SessionMetaSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(SESSION_TITLE_MAX_LENGTH),
  workingDirectory: z.string().min(1),
  projectIdentity: ProjectIdentitySchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type SessionMeta = z.infer<typeof SessionMetaSchema>;

export const SessionRecordSchema = z.discriminatedUnion('type', [
  z.object({ schemaVersion: z.literal(1), type: z.literal('meta'), session: SessionMetaSchema }),
  z.object({ schemaVersion: z.literal(1), type: z.literal('message'), message: MessageSchema }),
  z.object({ schemaVersion: z.literal(1), type: z.literal('title'), title: z.string() })
]);
export type SessionRecord = z.infer<typeof SessionRecordSchema>;

export const ProviderProtocolSchema = z.literal('openai_chat_completions');
export type ProviderProtocol = z.infer<typeof ProviderProtocolSchema>;

export const ModelSelectionSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().trim().min(1)
});
export type ModelSelection = z.infer<typeof ModelSelectionSchema>;

export const ProviderConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1),
  protocol: ProviderProtocolSchema,
  baseUrl: z.string().url(),
  model: z.string().trim().min(1),
  models: z.array(z.string().trim().min(1)).min(1),
  contextWindowTokens: z.number().int().min(8_192).max(2_000_000),
  maxOutputTokens: z.number().int().min(256).max(128_000),
  hasApiKey: z.boolean().default(false)
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const DEFAULT_PROVIDERS: ProviderConfig[] = [
  {
    id: 'openai', name: 'OpenAI / 兼容服务', protocol: 'openai_chat_completions',
    baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini', models: ['gpt-5-mini'],
    contextWindowTokens: 128_000, maxOutputTokens: 8_192, hasApiKey: false
  }
];

export const ProviderSettingsSchema = z.object({
  activeProviderId: z.string().min(1).default('openai'),
  providers: z.array(ProviderConfigSchema).min(1).default(() => DEFAULT_PROVIDERS.map((provider) => ({ ...provider }))),
  utilityModel: ModelSelectionSchema.default({ providerId: 'openai', model: 'gpt-5-mini' }),
  memory: MemorySettingsSchema.default(() => structuredClone(DEFAULT_MEMORY_SETTINGS)),
  extensions: ExtensionSettingsSchema.default({
    mcpServers: [], skills: { directories: [], disabled: [] }, browser: { ...DEFAULT_BROWSER_SETTINGS }
  })
}).superRefine((settings, context) => {
  const ids = new Set<string>();
  for (const provider of settings.providers) {
    if (ids.has(provider.id)) context.addIssue({ code: 'custom', message: `Duplicate provider id: ${provider.id}` });
    ids.add(provider.id);
    if (!provider.models.includes(provider.model)) {
      context.addIssue({ code: 'custom', message: `Default model is missing from provider ${provider.id}.` });
    }
    if (provider.maxOutputTokens >= provider.contextWindowTokens) {
      context.addIssue({ code: 'custom', message: `Max output must be smaller than the context window for ${provider.id}.` });
    }
  }
  if (!ids.has(settings.activeProviderId)) context.addIssue({ code: 'custom', message: 'Active provider does not exist.' });
  const utilityProvider = settings.providers.find((provider) => provider.id === settings.utilityModel.providerId);
  if (!utilityProvider?.models.includes(settings.utilityModel.model)) {
    context.addIssue({ code: 'custom', message: 'Utility model does not exist.' });
  }
});
export type ProviderSettings = z.infer<typeof ProviderSettingsSchema>;
