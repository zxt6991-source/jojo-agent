import { JsonlSessionStore, SqliteServerStateStore } from '@desktop-agent/storage';
import { DEFAULT_SESSION_TITLE, type ProjectIdentity, type SessionMeta } from '@desktop-agent/contracts';

/** JSONL supplies legacy imports and deletion barriers; online metadata belongs to application SQLite. */
export class DesktopSessionMetadataStore extends JsonlSessionStore {
  private legacyDiscovery: Promise<void> | undefined;

  constructor(directory: string, private readonly applicationDatabase: string) { super(directory); }

  override async create(...args: Parameters<JsonlSessionStore['create']>): Promise<SessionMeta> {
    return this.withMetadata(await super.create(...args));
  }

  override async get(sessionId: string): Promise<SessionMeta | null> {
    if (await this.isDeleted(sessionId)) return null;
    const state = new SqliteServerStateStore(this.applicationDatabase);
    try {
      const saved = state.getDesktopSessionMetadata(sessionId);
      if (saved) return saved;
      const legacy = await super.get(sessionId);
      return legacy ? this.mergeMetadata(legacy, state) : null;
    } catch (error) {
      if (error instanceof Error && error.message.includes('application_session_deleted')) return null;
      throw error;
    } finally { await state.close(); }
  }

  override async list(): Promise<SessionMeta[]> {
    if (!this.legacyDiscovery) {
      this.legacyDiscovery = this.importLegacyMetadata().catch(error => {
        this.legacyDiscovery = undefined;
        throw error;
      });
    }
    await this.legacyDiscovery;
    const state = new SqliteServerStateStore(this.applicationDatabase);
    try {
      const sessions = state.listDesktopSessionMetadata();
      const visible = await Promise.all(sessions.map(async meta => await this.isDeleted(meta.id) ? null : meta));
      return visible.filter((meta): meta is SessionMeta => meta !== null);
    } finally { await state.close(); }
  }

  private async importLegacyMetadata(): Promise<void> {
    const sessions = await super.list();
    const state = new SqliteServerStateStore(this.applicationDatabase);
    try {
      for (const meta of sessions) {
        try { this.mergeMetadata(meta, state); }
        catch (error) {
          if (!(error instanceof Error) || !error.message.includes('application_session_deleted')) throw error;
        }
      }
    } finally { await state.close(); }
  }

  override async bindProject(sessionId: string, workingDirectory: string, projectIdentity: ProjectIdentity): Promise<SessionMeta> {
    const meta = await this.get(sessionId);
    if (!meta) throw new Error(`session_unavailable: ${sessionId}`);
    const state = new SqliteServerStateStore(this.applicationDatabase);
    try {
      state.bindSessionProject(sessionId, workingDirectory, projectIdentity);
      return this.mergeMetadata(meta, state);
    } finally { await state.close(); }
  }

  override async loadForMigration(sessionId: string): ReturnType<JsonlSessionStore['loadForMigration']> {
    const snapshot = await super.loadForMigration(sessionId);
    return { ...snapshot, meta: await this.withMetadata(snapshot.meta) };
  }

  override async rename(sessionId: string, title: string): Promise<void> {
    const meta = await this.get(sessionId);
    if (!meta) throw new Error(`session_unavailable: ${sessionId}`);
    const state = new SqliteServerStateStore(this.applicationDatabase);
    try {
      state.importLegacySessionTitle(sessionId, meta.title, meta);
      await state.sessions.patch(sessionId, { title });
    } finally { await state.close(); }
  }

  private async withMetadata(meta: SessionMeta): Promise<SessionMeta> {
    const state = new SqliteServerStateStore(this.applicationDatabase);
    try { return this.mergeMetadata(meta, state); }
    finally { await state.close(); }
  }

  private mergeMetadata(meta: SessionMeta, state: SqliteServerStateStore): SessionMeta {
    const record = state.importLegacySessionTitle(meta.id, meta.title, meta);
    const project = state.importLegacySessionProject(meta);
    return { id: meta.id, createdAt: meta.createdAt, ...project, title: record.title ?? DEFAULT_SESSION_TITLE, updatedAt: record.updatedAt > meta.updatedAt ? record.updatedAt : meta.updatedAt };
  }
}
