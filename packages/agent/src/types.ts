import type {
  AgentEvent,
  ApprovalRequest,
  ExecutionScope,
  Message,
  ModelProvider,
  PermissionGate,
  Tool
} from '@desktop-agent/contracts';
import type { AgentLoopBudgetOptions, AgentLoopSafetyPolicy } from './loop/types.js';

export type AgentRunOptions = {
  sessionId: string;
  workingDirectory: string;
  /** Phase-A scope metadata. workingDirectory remains required for legacy adapters. */
  executionScope?: ExecutionScope;
  model: string;
  history: Message[];
  userText: string;
  userContent?: Extract<Message['content'][number], { type: 'text' | 'image' | 'file' }>[];
  userImages?: Extract<Message['content'][number], { type: 'image' }>[];
  userFiles?: Extract<Message['content'][number], { type: 'text' | 'file' }>[];
  provider: ModelProvider;
  tools: Tool[];
  /** Trusted runtime instructions, for example connected MCP server instructions. */
  instructions?: string[];
  /** Returns tools that became available during this turn, such as lazily discovered MCP tools. */
  getTools?: (context: { contextWindowTokens: number; maxOutputTokens: number }) => Tool[];
  permissionGate: PermissionGate;
  signal: AbortSignal;
  maxIterations?: number;
  /** Structured task budget. Takes precedence over the legacy maxIterations option. */
  loopBudget?: AgentLoopBudgetOptions;
  /** Trusted runtime policy. Never populate this from a prompt or untrusted workflow input. */
  loopSafety?: AgentLoopSafetyPolicy;
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
