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
  userImages?: Extract<Message['content'][number], { type: 'image' }>[];
  provider: ModelProvider;
  tools: Tool[];
  /** Trusted runtime instructions, for example connected MCP server instructions. */
  instructions?: string[];
  /** Returns tools that became available during this turn, such as lazily discovered MCP tools. */
  getTools?: (context: { contextWindowTokens: number; maxOutputTokens: number }) => Tool[];
  permissionGate: PermissionGate;
  signal: AbortSignal;
  maxIterations?: number;
  /** Return accumulated messages instead of throwing when the iteration limit is reached. */
  allowPartialOnMaxIterations?: boolean;
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
