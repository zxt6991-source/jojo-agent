import { isPlaceholderSessionTitle, sessionTitleFromPrompt, type Message, type ProjectIdentity, type SessionMeta } from '@desktop-agent/contracts';
import { SessionMetadataOperationSchema, type SessionMetadataOperation, type SessionMetadataResult } from '@desktop-agent/contracts/application';

export interface SessionMetadataPort {
  list(): Promise<SessionMeta[]>;
  get(sessionId: string): Promise<SessionMeta | null>;
  create(title: string, directory: string, project?: ProjectIdentity, bound?: boolean): Promise<SessionMeta>;
  rename(sessionId: string, title: string): Promise<void>;
  bindProject(sessionId: string, directory: string, project: ProjectIdentity): Promise<SessionMeta>;
  delete(sessionId: string): Promise<void>;
}
export type SessionMetadataServiceOptions = {
  store: SessionMetadataPort;
  defaultDirectory: string;
  ensureDirectory(directory: string): Promise<void>;
  resolveProject(directory: string): Promise<ProjectIdentity | undefined>;
  readMessages(sessionId: string): Promise<Message[]>;
  stopSession(sessionId: string): Promise<void>;
  deleteRuntimeSession(sessionId: string): Promise<void>;
  deleteApplicationSession(sessionId: string): Promise<void>;
};

/** Coordinates metadata mutations and deletion barriers independently of Electron and SQLite. */
export class SessionMetadataService {
  private readonly deleting = new Map<string, Promise<void>>();
  constructor(private readonly options: SessionMetadataServiceOptions) {}

  async execute(raw: SessionMetadataOperation): Promise<SessionMetadataResult> {
    const input = SessionMetadataOperationSchema.parse(raw);
    if ('sessionId' in input && this.deleting.has(input.sessionId) && input.action !== 'delete') throw new Error(`session_deleting: ${input.sessionId}`);
    const store = this.options.store;
    switch (input.action) {
      case 'get': return store.get(input.sessionId);
      case 'list': {
        const sessions = (await store.list()).filter(session => !this.deleting.has(session.id));
        return (await Promise.all(sessions.map(async session => {
          const messages = await this.options.readMessages(session.id);
          const prompt = messages.find(message => message.role === 'user' && !message.metadata?.internal)?.content
            .flatMap(block => block.type === 'text' ? [block.text] : []).join('');
          return { ...session,
            title: prompt && isPlaceholderSessionTitle(session.title, session.workingDirectory) ? sessionTitleFromPrompt(prompt) : session.title,
            updatedAt: messages.reduce((latest, message) => message.createdAt > latest ? message.createdAt : latest, session.updatedAt)
          };
        }))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      }
      case 'create': {
        const directory = input.workingDirectory ?? this.options.defaultDirectory;
        await this.options.ensureDirectory(directory);
        const project = input.workingDirectory ? await this.options.resolveProject(directory) : undefined;
        return store.create(input.title, directory, project, Boolean(input.workingDirectory));
      }
      case 'bindProject': {
        const project = await this.options.resolveProject(input.workingDirectory);
        if (!project) throw new Error('所选项目目录不存在或无法访问。');
        if (this.deleting.has(input.sessionId)) throw new Error(`session_deleting: ${input.sessionId}`);
        return store.bindProject(input.sessionId, input.workingDirectory, project);
      }
      case 'rename': await store.rename(input.sessionId, input.title); return null;
      case 'delete': await this.remove(input.sessionId); return null;
    }
  }

  private remove(sessionId: string): Promise<void> {
    const existing = this.deleting.get(sessionId);
    if (existing) return existing;
    const task = Promise.resolve().then(async () => {
      await this.options.stopSession(sessionId);
      await this.options.store.delete(sessionId);
      await this.options.deleteRuntimeSession(sessionId);
      await this.options.deleteApplicationSession(sessionId);
    }).finally(() => this.deleting.delete(sessionId));
    this.deleting.set(sessionId, task);
    return task;
  }
}
