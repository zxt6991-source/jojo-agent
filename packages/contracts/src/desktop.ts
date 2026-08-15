import { z } from 'zod';
import type { AgentEvent } from './agent';
import type { Message } from './messages';
import type { ProviderSettings, SessionMeta } from './persistence';
import { SESSION_TITLE_MAX_LENGTH } from './persistence';
import type { WorkspaceChanges } from './workspace';
import { ExtensionSettingsSchema } from './extensions';
import type { ExtensionSettings, ExtensionStatus, SkillDetail, SkillOperationResult } from './extensions';

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
export const McpServerIdInputSchema = z.object({ serverId: z.string().trim().min(1).max(64) });
export const SkillPathInputSchema = z.object({ path: z.string().trim().min(1).max(4_096) });
export const CreateSkillInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(4_000),
  instructions: z.string().max(120_000).default('')
});
export const UpdateSkillInputSchema = z.object({
  path: z.string().trim().min(1).max(4_096),
  content: z.string().min(1).max(120_000)
});
export const ImportSkillInputSchema = z.object({
  replacePath: z.string().trim().min(1).max(4_096).optional()
});
export const GetExtensionStatusInputSchema = z.object({ workingDirectory: z.string().trim().min(1).max(4_096).optional() });

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

export const SaveExtensionSettingsInputSchema = ExtensionSettingsSchema;

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
  getExtensionStatus(input?: z.input<typeof GetExtensionStatusInputSchema>): Promise<ExtensionStatus>;
  getSkillDetail(input: z.input<typeof SkillPathInputSchema>): Promise<SkillDetail>;
  createSkill(input: z.input<typeof CreateSkillInputSchema>): Promise<SkillOperationResult>;
  updateSkill(input: z.input<typeof UpdateSkillInputSchema>): Promise<SkillOperationResult>;
  importSkill(input?: z.input<typeof ImportSkillInputSchema>): Promise<SkillOperationResult>;
  exportSkill(input: z.input<typeof SkillPathInputSchema>): Promise<SkillOperationResult>;
  trashSkill(input: z.input<typeof SkillPathInputSchema>): Promise<SkillOperationResult>;
  saveExtensionSettings(input: z.input<typeof SaveExtensionSettingsInputSchema>): Promise<ExtensionSettings>;
  connectMcpOAuth(input: z.input<typeof McpServerIdInputSchema>): Promise<void>;
  disconnectMcpOAuth(input: z.input<typeof McpServerIdInputSchema>): Promise<void>;
  onAgentEvent(listener: (event: AgentEvent) => void): () => void;
  onSessionsChanged(listener: () => void): () => void;
  onExtensionsChanged(listener: () => void): () => void;
};

export type WorkerCommand =
  | { type: 'turn.start'; payload: z.input<typeof StartTurnInputSchema> }
  | { type: 'turn.cancel'; sessionId: string }
  | { type: 'approval.resolve'; requestId: string; allow: boolean }
  | { type: 'config.update'; settings: ProviderSettings; apiKeys: Record<string, string>; mcpOAuthCredentials: Record<string, unknown> }
  | { type: 'mcp.oauth.start'; requestId: string; serverId: string; redirectUrl: string; state: string }
  | { type: 'mcp.oauth.callback'; requestId: string; serverId: string; callbackParams: string }
  | { type: 'mcp.oauth.disconnect'; requestId: string; serverId: string };

export type WorkerMessage =
  | { type: 'ready' }
  | { type: 'agent.event'; event: AgentEvent }
  | { type: 'sessions.changed' }
  | { type: 'extensions.status'; status: ExtensionStatus }
  | { type: 'mcp.oauth.authorization'; requestId: string; url: string }
  | { type: 'mcp.oauth.credentials'; serverId: string; credentials: unknown }
  | { type: 'mcp.oauth.result'; requestId: string; ok: boolean; error?: string }
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
  getExtensionStatus: 'extensions:status',
  getSkillDetail: 'extensions:skill-detail',
  createSkill: 'extensions:skill-create',
  updateSkill: 'extensions:skill-update',
  importSkill: 'extensions:skill-import',
  exportSkill: 'extensions:skill-export',
  trashSkill: 'extensions:skill-trash',
  saveExtensionSettings: 'extensions:save',
  connectMcpOAuth: 'extensions:mcp-oauth-connect',
  disconnectMcpOAuth: 'extensions:mcp-oauth-disconnect',
  agentEvent: 'agent:event',
  sessionsChanged: 'sessions:changed',
  extensionsChanged: 'extensions:changed'
} as const;
