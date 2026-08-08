import { z } from 'zod';

export const ToolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown()
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const ToolResultSchema = z.object({
  callId: z.string().min(1),
  ok: z.boolean(),
  content: z.string(),
  truncated: z.boolean().optional(),
  code: z.string().optional()
});
export type ToolResult = z.infer<typeof ToolResultSchema>;

export const ContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('tool_call'), call: ToolCallSchema }),
  z.object({ type: z.literal('tool_result'), result: ToolResultSchema })
]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

export const MessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(['user', 'assistant', 'tool']),
  content: z.array(ContentBlockSchema),
  createdAt: z.string().datetime()
});
export type Message = z.infer<typeof MessageSchema>;

export const ToolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown())
});
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

export type ModelRequest = {
  model: string;
  messages: Message[];
  tools: ToolDefinition[];
  signal: AbortSignal;
};

export type ModelEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call_delta'; id: string; name?: string; argumentsDelta: string }
  | { type: 'tool_call_completed'; call: ToolCall }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number }
  | { type: 'response_completed'; stopReason: string }
  | { type: 'response_failed'; code: string; message: string };

export interface ModelProvider {
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}

export type ToolContext = {
  workingDirectory: string;
  signal: AbortSignal;
  approved: boolean;
  onProgress: (text: string) => void;
};

export interface Tool {
  definition: ToolDefinition;
  execute(input: unknown, context: ToolContext): Promise<ToolResult>;
}

export type ApprovalRequest = {
  requestId: string;
  sessionId: string;
  call: ToolCall;
  reason: string;
};

export const WorkspaceChangeSchema = z.object({
  path: z.string().min(1),
  status: z.enum(['added', 'modified', 'deleted', 'untracked']),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  patch: z.string(),
  truncated: z.boolean()
});
export type WorkspaceChange = z.infer<typeof WorkspaceChangeSchema>;

export const WorkspaceChangesSchema = z.object({
  isGitRepository: z.boolean(),
  files: z.array(WorkspaceChangeSchema),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  truncated: z.boolean()
});
export type WorkspaceChanges = z.infer<typeof WorkspaceChangesSchema>;

export type PermissionDecision =
  | { decision: 'allow' }
  | { decision: 'deny'; reason: string }
  | { decision: 'ask'; request: ApprovalRequest };

export interface PermissionGate {
  check(call: ToolCall, context: { sessionId: string; workingDirectory: string }): Promise<PermissionDecision>;
}

export type AgentEvent =
  | { type: 'turn.started'; sessionId: string; turnId: string }
  | { type: 'text.delta'; text: string }
  | { type: 'tool.started'; id: string; name: string; input: unknown }
  | { type: 'tool.progress'; id: string; text: string }
  | { type: 'tool.finished'; id: string; result: ToolResult }
  | { type: 'approval.required'; request: ApprovalRequest }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number }
  | { type: 'turn.completed'; stopReason: string }
  | { type: 'turn.cancelled' }
  | { type: 'turn.failed'; code: string; message: string };

export const SessionMetaSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  workingDirectory: z.string().min(1),
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

export const ProviderSettingsSchema = z.object({
  baseUrl: z.string().url().default('https://api.openai.com/v1'),
  model: z.string().min(1).default('gpt-5-mini'),
  hasApiKey: z.boolean().default(false)
});
export type ProviderSettings = z.infer<typeof ProviderSettingsSchema>;

export const CreateSessionInputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  workingDirectory: z.string().min(1)
});
export const RenameSessionInputSchema = z.object({ sessionId: z.string(), title: z.string().trim().min(1).max(120) });
export const StartTurnInputSchema = z.object({ sessionId: z.string(), text: z.string().trim().min(1).max(100_000) });
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
