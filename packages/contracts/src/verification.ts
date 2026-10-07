import { z } from 'zod';
import type { ToolCall, ToolResult } from './messages.js';
import type { Message } from './messages.js';

export const VerificationKindSchema = z.enum(['lint', 'typecheck', 'test']);
export const VerificationProfileSchema = z.object({
  version: z.literal(1),
  commands: z.array(z.object({
    id: z.string().min(1).max(128), kind: VerificationKindSchema,
    command: z.string().min(1).refine(value => !/\s/u.test(value)),
    args: z.array(z.string()).max(100).default([]), cwd: z.string().default('.'),
    timeoutMs: z.number().int().min(1000).max(300000).default(120000),
    scope: z.string().min(1).max(1000)
  }).strict()).max(20),
  budgetMs: z.number().int().min(1000).max(900000).default(300000)
}).strict();
export type VerificationProfile = z.infer<typeof VerificationProfileSchema>;
export const VerificationRequestSchema = z.object({
  kind: VerificationKindSchema, scope: z.string().min(1).max(1000),
  profileId: z.string().min(1).max(128).optional()
}).strict();
export const VerificationRecordSchema = z.object({
  kind: VerificationKindSchema, scope: z.string().min(1).max(1000),
  profileId: z.string().min(1).max(128).optional(),
  command: z.string(), args: z.array(z.string()), cwd: z.string(),
  startedAt: z.string().datetime(), finishedAt: z.string().datetime(),
  exitCode: z.number().int().nullable(),
  status: z.enum(['passed', 'failed', 'skipped', 'cancelled']),
  changeId: z.string(), outputRef: z.string().optional(),
  reason: z.string().optional()
}).strict();
export type VerificationRecord = z.infer<typeof VerificationRecordSchema>;

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
export function verificationFacts(messages: readonly Message[]): (VerificationRecord & { stale: boolean })[] {
  const changeId = workspaceChangeId(messages);
  const records = messages.flatMap(message => message.content.flatMap(block =>
    block.type === 'tool_result' && block.result.verification
      ? [{ ...block.result.verification, stale: block.result.verification.changeId !== changeId }] : []));
  const checks = messages.flatMap(message => message.content.flatMap(block => block.type === 'tool_result' && block.result.verificationChecks ? [block.result.verificationChecks] : [])).at(-1) ?? [];
  const skipped = checks.filter(check => !records.some(record => record.profileId === check.profileId && record.command === check.command && JSON.stringify(record.args) === JSON.stringify(check.args) && record.startedAt >= check.startedAt));
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
