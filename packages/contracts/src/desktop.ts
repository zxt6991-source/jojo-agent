import { z } from 'zod';
import type { AgentEvent } from './agent';
import type { Message } from './messages';
import type { ProviderSettings, SessionMeta } from './persistence';
import type { WorkspaceChanges } from './workspace';

export const CreateSessionInputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  workingDirectory: z.string().min(1)
});

export const RenameSessionInputSchema = z.object({
  sessionId: z.string(),
  title: z.string().trim().min(1).max(120)
});

export const StartTurnInputSchema = z.object({
  sessionId: z.string(),
  text: z.string().trim().min(1).max(100_000)
});

export const SessionIdInputSchema = z.object({ sessionId: z.string() });
export const ApprovalInputSchema = z.object({ requestId: z.string(), allow: z.boolean() });

export const SaveSettingsInputSchema = z.object({
  baseUrl: z.string().url(),
  model: z.string().min(1),
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
  saveSettings(input: z.input<typeof SaveSettingsInputSchema>): Promise<ProviderSettings>;
  onAgentEvent(listener: (event: AgentEvent) => void): () => void;
  onSessionsChanged(listener: () => void): () => void;
};

export type WorkerCommand =
  | { type: 'turn.start'; payload: z.input<typeof StartTurnInputSchema> }
  | { type: 'turn.cancel'; sessionId: string }
  | { type: 'approval.resolve'; requestId: string; allow: boolean }
  | { type: 'config.update'; settings: ProviderSettings; apiKey: string };

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
  saveSettings: 'settings:save',
  agentEvent: 'agent:event',
  sessionsChanged: 'sessions:changed'
} as const;
