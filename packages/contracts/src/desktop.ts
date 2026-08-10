import { z } from 'zod';
import type { AgentEvent } from './agent';
import type { Message } from './messages';
import type { ProviderSettings, SessionMeta } from './persistence';
import { SESSION_TITLE_MAX_LENGTH } from './persistence';
import type { WorkspaceChanges } from './workspace';

export const CreateSessionInputSchema = z.object({
  title: z.string().trim().min(1).max(SESSION_TITLE_MAX_LENGTH),
  workingDirectory: z.string().min(1)
});

export const RenameSessionInputSchema = z.object({
  sessionId: z.string(),
  title: z.string().trim().min(1).max(SESSION_TITLE_MAX_LENGTH)
});

export const StartTurnInputSchema = z.object({
  sessionId: z.string(),
  text: z.string().trim().min(1).max(100_000),
  providerId: z.string().trim().min(1),
  model: z.string().trim().min(1)
});

export const SessionIdInputSchema = z.object({ sessionId: z.string() });
export const ApprovalInputSchema = z.object({ requestId: z.string(), allow: z.boolean() });

export const SaveSettingsInputSchema = z.object({
  activeProviderId: z.string().min(1),
  provider: z.object({
    id: z.string().min(1),
    name: z.string().trim().min(1),
    protocol: z.literal('openai_chat_completions'),
    baseUrl: z.string().url(),
    model: z.string().min(1),
    models: z.array(z.string().trim().min(1)).min(1),
    contextWindowTokens: z.number().int().min(8_192).max(2_000_000),
    maxOutputTokens: z.number().int().min(256).max(128_000)
  }),
  utilityModel: z.object({ providerId: z.string().min(1), model: z.string().min(1) }),
  apiKey: z.string().optional()
});

export const ListModelsInputSchema = z.object({
  protocol: z.literal('openai_chat_completions'),
  baseUrl: z.string().url(),
  apiKey: z.string().optional()
});

export type DesktopApi = {
  listSessions(): Promise<SessionMeta[]>;
  createSession(input: z.input<typeof CreateSessionInputSchema>): Promise<SessionMeta | null>;
  renameSession(input: z.input<typeof RenameSessionInputSchema>): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  loadMessages(sessionId: string): Promise<Message[]>;
  getWorkspaceChanges(sessionId: string): Promise<WorkspaceChanges>;
  startTurn(input: z.input<typeof StartTurnInputSchema>): Promise<void>;
  cancelTurn(sessionId: string): Promise<void>;
  resolveApproval(input: z.input<typeof ApprovalInputSchema>): Promise<void>;
  chooseDirectory(): Promise<string | null>;
  getSettings(): Promise<ProviderSettings>;
  listModels(input: z.input<typeof ListModelsInputSchema>): Promise<string[]>;
  saveSettings(input: z.input<typeof SaveSettingsInputSchema>): Promise<ProviderSettings>;
  onAgentEvent(listener: (event: AgentEvent) => void): () => void;
  onSessionsChanged(listener: () => void): () => void;
};

export type WorkerCommand =
  | { type: 'turn.start'; payload: z.input<typeof StartTurnInputSchema> }
  | { type: 'turn.cancel'; sessionId: string }
  | { type: 'approval.resolve'; requestId: string; allow: boolean }
  | { type: 'config.update'; settings: ProviderSettings; apiKeys: Record<string, string> };

export type WorkerMessage =
  | { type: 'ready' }
  | { type: 'agent.event'; event: AgentEvent }
  | { type: 'sessions.changed' }
  | { type: 'worker.error'; message: string };

export const IPC = {
  listSessions: 'sessions:list',
  createSession: 'sessions:create',
  renameSession: 'sessions:rename',
  deleteSession: 'sessions:delete',
  loadMessages: 'sessions:messages',
  getWorkspaceChanges: 'workspace:changes',
  startTurn: 'agent:start',
  cancelTurn: 'agent:cancel',
  resolveApproval: 'agent:approval',
  chooseDirectory: 'system:choose-directory',
  getSettings: 'settings:get',
  listModels: 'models:list',
  saveSettings: 'settings:save',
  agentEvent: 'agent:event',
  sessionsChanged: 'sessions:changed'
} as const;
