import type { ToolCall, ToolResult } from './messages';
import type { HookErrorCode, HookEventName } from './hooks';

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
  | {
      type: 'usage';
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheWriteInputTokens?: number;
      costUsd?: number;
    }
  | {
      type: 'context.updated';
      estimatedTokens: number;
      contextWindowTokens: number;
      compactedMessages: number;
      reclaimedToolCharacters: number;
      fixedTokens?: number;
      targetTokens?: number;
      messageBudgetTokens?: number;
      overCapacity?: boolean;
      iteration?: number;
      maxIterations?: number;
      runMaxIterations?: number;
      absoluteMaxIterations?: number;
      toolCalls?: number;
      repeatedToolCalls?: number;
      duplicateObservations?: number;
      elapsedMs?: number;
      finalResponseOnly?: boolean;
    }
  | { type: 'output.continuing'; attempt: number }
  | { type: 'turn.completed'; stopReason: string }
  | { type: 'turn.cancelled' }
  | { type: 'turn.failed'; code: string; message: string }
  | { type: 'hook.started'; eventId: string; hookId: string; hookEvent: HookEventName }
  | {
      type: 'hook.finished'; eventId: string; hookId: string; durationMs: number;
      outcome: 'neutral' | 'approve' | 'block' | 'injected' | 'side_effect';
    }
  | { type: 'hook.failed'; eventId: string; hookId: string; code: HookErrorCode; message: string };
