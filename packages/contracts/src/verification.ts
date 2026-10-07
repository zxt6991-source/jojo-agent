import { z } from 'zod';
import type { ToolCall, ToolResult } from './messages.js';
import type { Message } from './messages.js';

export const VerificationKindSchema = z.enum(['lint', 'typecheck', 'test']);
const RelativeGlobSchema = z.string().min(1).max(512).refine(value => !value.startsWith('/') && !value.includes('\\') && !value.split('/').includes('..') && !/[\0\r\n{}]/u.test(value) && !value.includes('[') && !value.includes(']'), 'Use relative *, ** and ? patterns only.');
export const WorkspaceRevisionInputsSchema = z.object({
  mode: z.enum(['git', 'paths']).default('paths'), include: z.array(RelativeGlobSchema).min(1).max(50),
  exclude: z.array(RelativeGlobSchema).max(50).default([]),
  maxFiles: z.number().int().min(1).max(100000).default(25000),
  maxBytes: z.number().int().min(1).max(536870912).default(134217728)
}).strict();
export type WorkspaceRevisionInputs = z.infer<typeof WorkspaceRevisionInputsSchema>;
export const WorkspaceRevisionSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/u).optional(), workspaceId: z.string().regex(/^[a-f0-9]{64}$/u),
  scopeHash: z.string().regex(/^[a-f0-9]{64}$/u), inputs: WorkspaceRevisionInputsSchema,
  capturedAt: z.string().datetime(), captureStatus: z.enum(['complete', 'unknown']),
  reason: z.string().max(256).optional(), fileCount: z.number().int().nonnegative(), byteCount: z.number().int().nonnegative()
}).strict().refine(value => value.captureStatus !== 'complete' || value.id !== undefined, 'Complete captures need an id.');
export type WorkspaceRevision = z.infer<typeof WorkspaceRevisionSchema>;
export type WorkspaceRevisionCapture = (request: { workingDirectory: string; inputs?: WorkspaceRevisionInputs; signal: AbortSignal }) => Promise<WorkspaceRevision>;
const ProfileCommandsSchema = z.array(z.object({
  id: z.string().min(1).max(128), kind: VerificationKindSchema,
  command: z.string().min(1).refine(value => !/\s/u.test(value)),
  args: z.array(z.string()).max(100).default([]), cwd: z.string().default('.'),
  timeoutMs: z.number().int().min(1000).max(300000).default(120000), scope: z.string().min(1).max(1000)
}).strict()).max(20).refine(commands => new Set(commands.map(command => command.id)).size === commands.length, 'Check ids must be unique.');
const ProfileFields = { commands: ProfileCommandsSchema, budgetMs: z.number().int().min(1000).max(900000).default(300000) };
export const VerificationProfileSchema = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), ...ProfileFields }).strict(),
  z.object({ version: z.literal(2), ...ProfileFields, inputs: WorkspaceRevisionInputsSchema }).strict()
]);
export type VerificationProfile = z.infer<typeof VerificationProfileSchema>;
export const VerificationBatchSchema = z.object({
  id: z.string().min(1).max(256), profileHash: z.string().regex(/^[a-f0-9]{64}$/u),
  createdAt: z.string().datetime(), deadlineAt: z.string().datetime(),
  profile: VerificationProfileSchema, revision: WorkspaceRevisionSchema
}).strict();
export type VerificationBatch = z.infer<typeof VerificationBatchSchema>;
export type VerificationBatchStatus = 'pending' | 'running' | 'completed' | 'cancelled' | 'budget_exhausted' | 'interrupted';
/** Derive lifecycle from immutable branch evidence; no second mutable status store. */
export function verificationBatchFacts(messages: readonly Message[], activeCallIds: readonly string[] = [], now = Date.now()): (VerificationBatch & { status: VerificationBatchStatus })[] {
  const calls = messages.flatMap(message => message.content.flatMap(block => block.type === 'tool_call' ? [block.call] : []));
  const results = messages.flatMap(message => message.content.flatMap(block => block.type === 'tool_result' ? [block.result] : []));
  return results.flatMap(result => result.verificationBatch ? [result.verificationBatch] : []).map(batch => {
    const attempts = calls.filter(call => call.name === 'verification_run' && call.input && typeof call.input === 'object' && 'batchId' in call.input && call.input.batchId === batch.id);
    const attempt = attempts.at(-1);
    const settled = attempt ? results.find(result => result.callId === attempt.id) : undefined;
    const checks = results.filter(result => result.verification?.batchId === batch.id);
    let status: VerificationBatchStatus = 'pending';
    if (attempt && activeCallIds.includes(attempt.id)) status = 'running';
    else if (attempt && !settled) status = 'interrupted';
    else if (settled?.code === 'cancelled' || checks.some(check => check.verification?.status === 'cancelled')) status = 'cancelled';
    else if (settled?.code === 'budget_exhausted' || checks.some(check => check.code === 'budget_exhausted')) status = 'budget_exhausted';
    else if (settled?.code === 'interrupted') status = 'interrupted';
    else if (settled || (checks.length && batch.profile.commands.every(command => checks.some(check => check.verification?.profileId === command.id)))) status = 'completed';
    else if (now >= Date.parse(batch.deadlineAt)) status = checks.length ? 'interrupted' : 'budget_exhausted';
    return { ...batch, status };
  });
}
export const VerificationRequestSchema = z.object({
  kind: VerificationKindSchema, scope: z.string().min(1).max(1000),
  profileId: z.string().min(1).max(128).optional(),
  batchId: z.string().min(1).max(256).optional()
}).strict();
export const VerificationRecordSchema = z.object({
  kind: VerificationKindSchema, scope: z.string().min(1).max(1000),
  profileId: z.string().min(1).max(128).optional(),
  command: z.string(), args: z.array(z.string()), cwd: z.string(),
  startedAt: z.string().datetime(), finishedAt: z.string().datetime(),
  exitCode: z.number().int().nullable(),
  status: z.enum(['passed', 'failed', 'skipped', 'cancelled']),
  changeId: z.string(), outputRef: z.string().optional(),
  batchId: z.string().min(1).max(256).optional(),
  revisionBefore: WorkspaceRevisionSchema.optional(), revisionAfter: WorkspaceRevisionSchema.optional(),
  validity: z.enum(['current', 'stale', 'unknown']).optional(),
  reason: z.string().optional()
}).strict();
export type VerificationRecord = z.infer<typeof VerificationRecordSchema>;
/** Bounded model summary. Full commands, scope configuration and outputs stay in the durable result. */
export function verificationEvidence(record: VerificationRecord & { stale?: boolean }) {
  return {
    kind: record.kind, scope: record.scope, profileId: record.profileId,
    batchId: record.batchId, outputRef: record.outputRef, status: record.status,
    exitCode: record.exitCode, validity: record.validity ?? (record.revisionBefore ? 'unknown' : 'legacy'),
    stale: record.stale, reason: record.reason?.slice(0, 256),
    revisionBefore: record.revisionBefore?.id, revisionAfter: record.revisionAfter?.id
  };
}

/** Conservative: commands and any successful write may change the workspace. */
export function workspaceChangeId(messages: readonly Message[]): string {
  const calls = new Map(messages.flatMap(message => message.content.flatMap(block =>
    block.type === 'tool_call' ? [[block.call.id, block.call.name] as const] : [])));
  let latest = 'initial';
  for (const message of messages) for (const block of message.content) {
    if (block.type !== 'tool_result') continue;
    const name = calls.get(block.result.callId);
    if (name === 'terminal' || (block.result.ok && ['write_file', 'edit_file', 'delete_file', 'skill_activate', 'apply_patch', 'file_undo'].includes(name ?? ''))) latest = block.result.callId;
  }
  return latest;
}
export function verificationValidity(record: VerificationRecord, current?: WorkspaceRevision): 'current' | 'stale' | 'unknown' {
  const before = record.revisionBefore, after = record.revisionAfter;
  if (!before || !after || before.captureStatus !== 'complete' || after.captureStatus !== 'complete' || !current || current.captureStatus !== 'complete') return 'unknown';
  return before.workspaceId === current.workspaceId && before.workspaceId === after.workspaceId && before.scopeHash === after.scopeHash && before.scopeHash === current.scopeHash && before.id === after.id && after.id === current.id ? 'current' : 'stale';
}
export function verificationFacts(messages: readonly Message[], revisions?: readonly WorkspaceRevision[]): (VerificationRecord & { stale: boolean })[] {
  const changeId = workspaceChangeId(messages);
  const observed = revisions ?? [...messages].reverse().find(message => message.metadata?.verificationRevisions)?.metadata?.verificationRevisions ?? [];
  const records = messages.flatMap(message => message.content.flatMap(block =>
    block.type === 'tool_result' && block.result.verification
      ? [(() => {
        const record = block.result.verification;
        if (!record.revisionBefore) return { ...record, stale: record.changeId !== changeId };
        const current = observed.filter(value => value.workspaceId === record.revisionBefore!.workspaceId && value.scopeHash === record.revisionBefore!.scopeHash).at(-1);
        const validity = verificationValidity(record, current);
        return { ...record, validity, stale: validity !== 'current' };
      })()] : []));
  const checks = messages.flatMap(message => message.content.flatMap(block => block.type === 'tool_result' && block.result.verificationChecks ? [block.result.verificationChecks] : [])).at(-1) ?? [];
  const skipped = checks.filter(check => !records.some(record => record.batchId === check.batchId && record.profileId === check.profileId && record.command === check.command && JSON.stringify(record.args) === JSON.stringify(check.args) && record.startedAt >= check.startedAt));
  return [...records, ...skipped.map(check => ({ ...check, stale: false }))];
}

/** Records checks rejected before a process starts as skipped, never as failed execution. */
export function verificationResult(call: ToolCall, result: ToolResult): ToolResult {
  if (result.verification || call.name !== 'terminal' || !call.input || typeof call.input !== 'object') return result;
  const input = call.input as Record<string, unknown>;
  const request = VerificationRequestSchema.safeParse(input.verification);
  if (!request.success || typeof input.command !== 'string') return result;
  const timestamp = new Date().toISOString();
  return { ...result, verification: {
    ...request.data, command: input.command,
    args: Array.isArray(input.args) ? input.args.filter((arg): arg is string => typeof arg === 'string') : [],
    cwd: typeof input.cwd === 'string' ? input.cwd : '.', startedAt: timestamp, finishedAt: timestamp,
    status: result.code === 'cancelled' ? 'cancelled' : 'skipped', exitCode: null,
    changeId: call.id, outputRef: call.id, reason: result.code ?? 'not_executed'
  } };
}
