import { z } from 'zod';
import { HookErrorCodeSchema, HookEventNameSchema } from './hooks.js';
import { ToolResultContentBlockSchema, type ToolCall } from './messages.js';
import type { ExecutionScope } from './execution-scope.js';

export const MAX_AGENT_EVENT_BYTES = 2 * 1024 * 1024;

const boundedJsonSchema = (depth: number): z.ZodType<unknown> => {
  const primitive = z.union([z.string().max(200_000), z.number().finite(), z.boolean(), z.null()]);
  if (depth === 0) return primitive;
  const child = z.lazy(() => boundedJsonSchema(depth - 1));
  return z.union([
    primitive,
    z.array(child).max(1_000),
    z.record(z.string().min(1).max(256), child).refine((value) => Object.keys(value).length <= 1_000, {
      message: 'JSON object has too many properties.'
    })
  ]);
};

export const BoundedJsonValueSchema = boundedJsonSchema(8);

const IpcToolCallSchema = z.object({
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
  input: BoundedJsonValueSchema
}).strict();

const IpcToolResultSchema = z.object({
  callId: z.string().min(1).max(256),
  ok: z.boolean(),
  content: z.string().max(1_500_000),
  contentBlocks: z.array(ToolResultContentBlockSchema).max(100).optional(),
  truncated: z.boolean().optional(),
  code: z.string().max(256).optional()
}).strict();

const TerminalSecurityApprovalPreviewSchema = z.object({
  kind: z.literal('terminal'), command: z.string().max(1_000),
  argumentsPreview: z.array(z.string().max(500)).max(20), cwd: z.string().max(4_096),
  risk: z.enum(['medium', 'high', 'critical']),
  sandbox: z.enum(['strong', 'container', 'soft', 'none']),
  network: z.enum(['none', 'host']),
  secretEnv: z.array(z.string().min(1).max(128)).max(20),
  capabilities: z.array(z.string().max(128)).max(50),
  reasons: z.array(z.string().max(2_000)).max(50)
}).strict();
const McpSecurityApprovalPreviewSchema = z.object({
  kind: z.literal('mcp'), serverId: z.string().min(1).max(64), serverName: z.string().min(1).max(120),
  toolName: z.string().min(1).max(256), risk: z.enum(['read', 'external_side_effect']),
  capabilities: z.array(z.string().max(128)).max(50),
  reasons: z.array(z.string().max(2_000)).max(50)
}).strict();
export const SecurityApprovalPreviewSchema = z.discriminatedUnion('kind', [
  TerminalSecurityApprovalPreviewSchema,
  McpSecurityApprovalPreviewSchema
]);
export type SecurityApprovalPreview = z.infer<typeof SecurityApprovalPreviewSchema>;

export const ApprovalRequestSchema = z.object({
  requestId: z.string().min(1).max(256),
  sessionId: z.string().min(1).max(256),
  call: IpcToolCallSchema,
  reason: z.string().max(20_000),
  preview: z.object({
    kind: z.enum(['create', 'update', 'delete']),
    path: z.string().max(4_096),
    patch: z.string().max(500_000),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    truncated: z.boolean().optional()
  }).strict().optional(),
  security: SecurityApprovalPreviewSchema.optional(),
  grant: z.object({
    kind: z.enum(['mcp_tool', 'approval']), key: z.string().min(1).max(512),
    options: z.array(z.enum(['once', 'session', 'similar', 'conversation'])).min(1).max(4)
  }).strict().optional()
}).strict();
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export type PermissionDecision =
  | { decision: 'allow' }
  | { decision: 'deny'; reason: string; code?: string }
  | { decision: 'ask'; request: ApprovalRequest };

export interface PermissionGate {
  check(call: ToolCall, context: {
    sessionId: string;
    workingDirectory: string;
    executionScope?: ExecutionScope;
  }): Promise<PermissionDecision>;
}

const AgentEventBaseSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('turn.started'), sessionId: z.string().min(1).max(256), turnId: z.string().min(1).max(256) }).strict(),
  z.object({ type: z.literal('text.delta'), text: z.string().max(100_000) }).strict(),
  z.object({ type: z.literal('tool.started'), id: z.string().min(1).max(256), name: z.string().min(1).max(256), input: BoundedJsonValueSchema }).strict(),
  z.object({ type: z.literal('tool.progress'), id: z.string().min(1).max(256), text: z.string().max(100_000) }).strict(),
  z.object({ type: z.literal('tool.finished'), id: z.string().min(1).max(256), result: IpcToolResultSchema }).strict(),
  z.object({ type: z.literal('approval.required'), request: ApprovalRequestSchema }).strict(),
  z.object({
    type: z.literal('usage'),
    inputTokens: z.number().finite().nonnegative().optional(), outputTokens: z.number().finite().nonnegative().optional(),
    cacheReadInputTokens: z.number().finite().nonnegative().optional(), cacheWriteInputTokens: z.number().finite().nonnegative().optional(),
    costUsd: z.number().finite().nonnegative().optional()
  }).strict(),
  z.object({
    type: z.literal('context.updated'),
    estimatedTokens: z.number().finite().nonnegative(), contextWindowTokens: z.number().finite().positive(),
    compactedMessages: z.number().int().nonnegative(), reclaimedToolCharacters: z.number().int().nonnegative(),
    fixedTokens: z.number().finite().nonnegative().optional(), targetTokens: z.number().finite().nonnegative().optional(),
    messageBudgetTokens: z.number().finite().nonnegative().optional(), overCapacity: z.boolean().optional(),
    iteration: z.number().int().nonnegative().optional(), maxIterations: z.number().int().nonnegative().optional(),
    runMaxIterations: z.number().int().nonnegative().optional(), absoluteMaxIterations: z.number().int().nonnegative().optional(),
    toolCalls: z.number().int().nonnegative().optional(), repeatedToolCalls: z.number().int().nonnegative().optional(),
    duplicateObservations: z.number().int().nonnegative().optional(), elapsedMs: z.number().finite().nonnegative().optional(),
    finalResponseOnly: z.boolean().optional()
  }).strict(),
  z.object({ type: z.literal('output.continuing'), attempt: z.number().int().positive() }).strict(),
  z.object({ type: z.literal('turn.completed'), stopReason: z.string().max(4_000) }).strict(),
  z.object({ type: z.literal('turn.cancelled') }).strict(),
  z.object({ type: z.literal('turn.failed'), code: z.string().min(1).max(256), message: z.string().max(100_000) }).strict(),
  z.object({
    type: z.literal('memory.lifecycle'),
    event: z.enum([
      'memory.handoff.started', 'memory.handoff.completed', 'memory.handoff.reused', 'memory.handoff.failed',
      'memory.snapshot.refresh.requested', 'memory.snapshot.refreshed', 'memory.snapshot.refresh.failed',
      'memory.subagent.bound', 'memory.workflow.bound', 'memory.workflow.binding.restored'
    ]),
    handoffId: z.string().max(512).optional(), snapshotId: z.string().max(512).optional(),
    previousSnapshotId: z.string().max(512).optional(), warning: z.string().max(20_000).optional()
  }).strict(),
  z.object({
    type: z.literal('memory.candidate'),
    event: z.enum([
      'memory.candidate.eligibility_matched', 'memory.candidate.extraction_started', 'memory.candidate.created',
      'memory.candidate.deduplicated', 'memory.candidate.rejected', 'memory.candidate.expired',
      'memory.candidate.accept.requested', 'memory.candidate.accepted', 'memory.candidate.write_failed'
    ]),
    operationId: z.string().max(512).optional(), candidateId: z.string().max(512).optional(),
    count: z.number().int().nonnegative().optional(), warning: z.string().max(20_000).optional()
  }).strict(),
  z.object({
    type: z.literal('memory.semantic'),
    event: z.enum([
      'memory.embedding.job.queued', 'memory.embedding.completed', 'memory.embedding.failed',
      'memory.semantic.search.started', 'memory.semantic.search.completed', 'memory.semantic.search.fallback',
      'memory.semantic.rebuild.started', 'memory.semantic.rebuild.progress', 'memory.semantic.rebuild.completed',
      'memory.semantic.model.changed'
    ]),
    count: z.number().int().nonnegative().optional(), warning: z.string().max(20_000).optional()
  }).strict(),
  z.object({ type: z.literal('hook.started'), eventId: z.string().min(1).max(256), hookId: z.string().min(1).max(256), hookEvent: HookEventNameSchema }).strict(),
  z.object({
    type: z.literal('hook.finished'), eventId: z.string().min(1).max(256), hookId: z.string().min(1).max(256),
    durationMs: z.number().finite().nonnegative(), outcome: z.enum(['neutral', 'approve', 'block', 'injected', 'side_effect'])
  }).strict(),
  z.object({
    type: z.literal('hook.failed'), eventId: z.string().min(1).max(256), hookId: z.string().min(1).max(256),
    code: HookErrorCodeSchema, message: z.string().max(100_000)
  }).strict()
]);

export function serializedIpcBytes(value: unknown): number {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
  catch { return Number.POSITIVE_INFINITY; }
}

export const AgentEventSchema = AgentEventBaseSchema.superRefine((value, context) => {
  if (serializedIpcBytes(value) > MAX_AGENT_EVENT_BYTES) {
    context.addIssue({ code: 'custom', message: 'Agent event exceeds the IPC size limit.' });
  }
});
export type AgentEvent = z.infer<typeof AgentEventSchema>;
