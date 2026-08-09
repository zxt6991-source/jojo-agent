import type { ToolCall, ToolResult } from './messages';

export type ApprovalRequest = {
  requestId: string;
  sessionId: string;
  call: ToolCall;
  reason: string;
  preview?: {
    kind: 'create' | 'update' | 'delete';
    path: string;
    patch: string;
    additions: number;
    deletions: number;
    truncated?: boolean;
  };
};

export type PermissionDecision =
  | { decision: 'allow' }
  | { decision: 'deny'; reason: string; code?: string }
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
