import { appendFile, copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  MessageSchema,
  DEFAULT_PROVIDERS,
  ProviderSettingsSchema,
  SessionMetaSchema,
  SessionRecordSchema,
  isPlaceholderSessionTitle,
  sessionTitleFromPrompt,
  type Message,
  type ProviderSettings,
  type SessionMeta,
  type SessionRecord
} from '@desktop-agent/contracts';

export { JsonlWorkflowStore, MAX_WORKFLOW_JOURNAL_BYTES, workflowDefinitionHash } from './workflow-store.js';
export { JsonlAgentRuntimeStore, MAX_RUNTIME_JOURNAL_BYTES } from './runtime-store.js';
export { SqliteAgentRuntimeStore } from './sqlite-runtime-store.js';

const StoredConfigV1Schema = z.object({
  schemaVersion: z.literal(1),
  provider: z.object({ baseUrl: z.string().url(), model: z.string().min(1) })
});

const StoredConfigV2Schema = z.object({
  schemaVersion: z.literal(2),
  provider: z.object({
    baseUrl: z.string().url(), model: z.string().min(1),
    models: z.array(z.string().min(1)).min(1)
  })
});

const StoredProviderSchema = z.object({
  id: z.string().min(1), name: z.string().min(1),
  protocol: z.string().min(1),
  baseUrl: z.string().url(), model: z.string().min(1), models: z.array(z.string().min(1)).min(1),
  contextWindowTokens: z.number().int(), maxOutputTokens: z.number().int()
});

const StoredConfigV3Schema = z.object({
  schemaVersion: z.literal(3),
  activeProviderId: z.string().min(1),
  providers: z.array(StoredProviderSchema).min(1),
  utilityModel: z.object({ providerId: z.string().min(1), model: z.string().min(1) }),
  extensions: z.unknown().optional()
});

const StoredConfigSchema = z.union([StoredConfigV1Schema, StoredConfigV2Schema, StoredConfigV3Schema]);

export class JsonlSessionStore {
  private readonly locks = new Set<string>();
  constructor(private readonly directory: string) {}

  private async ensureDirectory(): Promise<void> { await mkdir(this.directory, { recursive: true }); }
  private file(sessionId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('Invalid session id.');
    return path.join(this.directory, `${sessionId}.jsonl`);
  }
  private async append(sessionId: string, record: SessionRecord): Promise<void> {
    await this.ensureDirectory();
    await appendFile(this.file(sessionId), `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a' });
  }
  async create(title: string, workingDirectory: string): Promise<SessionMeta> {
    const time = new Date().toISOString();
    const meta = SessionMetaSchema.parse({ id: crypto.randomUUID(), title, workingDirectory, createdAt: time, updatedAt: time });
    await this.append(meta.id, { schemaVersion: 1, type: 'meta', session: meta });
    return meta;
  }
  async list(): Promise<SessionMeta[]> {
    await this.ensureDirectory();
    const files = (await readdir(this.directory)).filter((file) => file.endsWith('.jsonl'));
    const sessions = await Promise.all(files.map(async (file) => {
      const id = file.slice(0, -6);
      try {
        const loaded = await this.load(id);
        const info = await stat(this.file(id));
        if (!loaded.meta) return null;
        const firstPrompt = loaded.messages.find((message) => message.role === 'user')?.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('');
        const derivedTitle = firstPrompt && isPlaceholderSessionTitle(loaded.meta.title, loaded.meta.workingDirectory)
          ? sessionTitleFromPrompt(firstPrompt)
          : loaded.meta.title;
        return { ...loaded.meta, title: derivedTitle, updatedAt: info.mtime.toISOString() };
      } catch { return null; }
    }));
    return sessions.filter((item): item is SessionMeta => item !== null).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async load(sessionId: string): Promise<{ meta: SessionMeta | null; messages: Message[]; warnings: string[] }> {
    let content: string;
    try { content = await readFile(this.file(sessionId), 'utf8'); }
    catch (error: any) {
      if (error?.code === 'ENOENT') return { meta: null, messages: [], warnings: [] };
      throw error;
    }
    let meta: SessionMeta | null = null;
    const messages: Message[] = [];
    const warnings: string[] = [];
    const lines = content.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line?.trim()) continue;
      let raw: unknown;
      try { raw = JSON.parse(line); }
      catch {
        warnings.push(`Ignored incomplete or invalid record at line ${index + 1}.`);
        continue;
      }
      const parsed = SessionRecordSchema.safeParse(raw);
      if (!parsed.success) {
        warnings.push(`Ignored unsupported record at line ${index + 1}.`);
        continue;
      }
      const record = parsed.data;
      if (record.type === 'meta') meta = record.session;
      else if (record.type === 'title') {
        const currentMeta: SessionMeta | null = meta;
        if (currentMeta) meta = Object.assign({}, currentMeta, { title: record.title }) as SessionMeta;
      }
      else if (record.type === 'message') messages.push(record.message);
    }
    return { meta, messages, warnings };
  }
  async messages(sessionId: string): Promise<Message[]> { return (await this.load(sessionId)).messages; }
  async get(sessionId: string): Promise<SessionMeta | null> { return (await this.load(sessionId)).meta; }
  async appendMessage(sessionId: string, message: Message): Promise<void> {
    await this.append(sessionId, { schemaVersion: 1, type: 'message', message: MessageSchema.parse(message) });
  }
  async rename(sessionId: string, title: string): Promise<void> {
    await this.append(sessionId, { schemaVersion: 1, type: 'title', title });
  }
  async delete(sessionId: string): Promise<void> {
    try { await unlink(this.file(sessionId)); }
    catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
  }
  acquire(sessionId: string): () => void {
    if (this.locks.has(sessionId)) throw new Error('A turn is already running for this session.');
    this.locks.add(sessionId);
    return () => this.locks.delete(sessionId);
  }
}

export class JsonConfigStore {
  constructor(private readonly filePath: string) {}
  async get(apiKeyState: boolean | Record<string, string> = false): Promise<ProviderSettings> {
    const hasKey = (id: string) => typeof apiKeyState === 'boolean' ? (id === 'openai' && apiKeyState) : Boolean(apiKeyState[id]);
    try {
      const stored = StoredConfigSchema.parse(JSON.parse(await readFile(this.filePath, 'utf8')));
      if (stored.schemaVersion === 1 || stored.schemaVersion === 2) {
        const models = stored.schemaVersion === 1 ? [stored.provider.model] : stored.provider.models;
        const providers = DEFAULT_PROVIDERS.map((provider) => provider.id === 'openai'
          ? { ...provider, ...stored.provider, models, hasApiKey: hasKey('openai') }
          : { ...provider, hasApiKey: hasKey(provider.id) });
        return ProviderSettingsSchema.parse({
          activeProviderId: 'openai', providers,
          utilityModel: { providerId: 'openai', model: stored.provider.model }
        });
      }
      const providers = stored.providers
        .filter((provider) => provider.protocol === 'openai_chat_completions')
        .map((provider) => ({ ...provider, protocol: 'openai_chat_completions' as const, hasApiKey: hasKey(provider.id) }));
      if (providers.length === 0) {
        return ProviderSettingsSchema.parse({
          activeProviderId: 'openai',
          providers: DEFAULT_PROVIDERS.map((provider) => ({ ...provider, hasApiKey: hasKey(provider.id) })),
          utilityModel: { providerId: 'openai', model: 'gpt-5-mini' }
        });
      }
      const activeProvider = providers.find((provider) => provider.id === stored.activeProviderId) ?? providers[0]!;
      const utilityProvider = providers.find((provider) => provider.id === stored.utilityModel.providerId);
      const utilityModel = utilityProvider?.models.includes(stored.utilityModel.model)
        ? stored.utilityModel
        : { providerId: activeProvider.id, model: activeProvider.model };
      return ProviderSettingsSchema.parse({
        activeProviderId: activeProvider.id,
        providers,
        utilityModel,
        ...(stored.extensions !== undefined ? { extensions: stored.extensions } : {})
      });
    } catch {
      return ProviderSettingsSchema.parse({
        activeProviderId: 'openai',
        providers: DEFAULT_PROVIDERS.map((provider) => ({ ...provider, hasApiKey: hasKey(provider.id) })),
        utilityModel: { providerId: 'openai', model: 'gpt-5-mini' }
      });
    }
  }
  async save(settings: ProviderSettings): Promise<void> {
    const validSettings = ProviderSettingsSchema.parse(settings);
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try { await copyFile(this.filePath, `${this.filePath}.bak`); } catch { /* first save */ }
    const temporary = `${this.filePath}.tmp`;
    const stored = {
      schemaVersion: 3,
      activeProviderId: validSettings.activeProviderId,
      providers: validSettings.providers.map(({ hasApiKey: _hasApiKey, ...provider }) => provider),
      utilityModel: validSettings.utilityModel,
      extensions: validSettings.extensions
    };
    await writeFile(temporary, JSON.stringify(stored, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}
