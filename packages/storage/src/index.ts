import { appendFile, copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  MessageSchema,
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

const StoredConfigV1Schema = z.object({
  schemaVersion: z.literal(1),
  provider: ProviderSettingsSchema.omit({ hasApiKey: true, models: true })
});

const StoredConfigV2Schema = z.object({
  schemaVersion: z.literal(2),
  provider: ProviderSettingsSchema.omit({ hasApiKey: true })
});

const StoredConfigSchema = z.union([StoredConfigV1Schema, StoredConfigV2Schema]);

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
  async get(hasApiKey = false): Promise<ProviderSettings> {
    try {
      const stored = StoredConfigSchema.parse(JSON.parse(await readFile(this.filePath, 'utf8')));
      if (stored.schemaVersion === 1) return { ...stored.provider, models: [stored.provider.model], hasApiKey };
      return { ...stored.provider, hasApiKey };
    } catch {
      return { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini', models: ['gpt-5-mini'], hasApiKey };
    }
  }
  async save(provider: Omit<ProviderSettings, 'hasApiKey'>): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try { await copyFile(this.filePath, `${this.filePath}.bak`); } catch { /* first save */ }
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, JSON.stringify({ schemaVersion: 2, provider }, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}
