import type {
  AgentEvent,
  ApprovalRequest,
  Message,
  ModelProvider,
  PermissionGate,
  Tool
} from '@desktop-agent/contracts';

export type AgentRunOptions = {
  sessionId: string;
  workingDirectory: string;
  model: string;
  history: Message[];
  userText: string;
  provider: ModelProvider;
  tools: Tool[];
  /** Returns tools that became available during this turn, such as lazily discovered MCP tools. */
  getTools?: () => Tool[];
  permissionGate: PermissionGate;
  signal: AbortSignal;
  maxIterations?: number;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  summarize?: (source: string, signal: AbortSignal) => Promise<string>;
  emit: (event: AgentEvent) => void;
  approve: (request: ApprovalRequest, signal: AbortSignal) => Promise<boolean>;
  commitMessage?: (message: Message) => Promise<void>;
};

export type AgentRunResult = {
  messages: Message[];
  stopReason: string;
};
