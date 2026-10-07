import { verificationResult, type ToolCall, type ToolResult } from '@desktop-agent/contracts';
import type { AgentRunOptions } from './types.js';
import { createAssistantMessage, createToolMessage } from './messages.js';
import { DEFAULT_AGENT_LOOP_RESOURCE_BUDGET } from './loop/types.js';
import { sha256 } from './loop/fingerprint.js';
import { executeToolCall, type ToolExecutionState } from './tool-execution.js';
export async function runVerificationBatch(parentCallId: string, input: { batchId: string; checkIds?: string[] }, options: AgentRunOptions, state: ToolExecutionState & { toolCalls: number; startedAt?: number }, append: (message: import('@desktop-agent/contracts').Message) => Promise<void>, lifecycle?: { execute(call: ToolCall, options: AgentRunOptions): Promise<ToolResult>; after?(call: ToolCall, result: ToolResult): Promise<void> }): Promise<ToolResult[]> {
  const batch = await options.readVerificationBatch?.(input.batchId);
  if (!batch) throw Object.assign(new Error('Batch is unavailable in this session branch.'), { code: 'verification_batch_invalid' });
  const ids = input.checkIds ?? batch.profile.commands.map(check => check.id);
  if (new Set(ids).size !== ids.length || ids.some(id => !batch.profile.commands.some(check => check.id === id))) throw Object.assign(new Error('Check ids must be unique members of the loaded Profile.'), { code: 'verification_batch_invalid' });
  const results: ToolResult[] = [];
  const wallLimit = options.loopBudget?.maxWallTimeMs ?? DEFAULT_AGENT_LOOP_RESOURCE_BUDGET.maxWallTimeMs!;
  const deadline = Math.min(Date.parse(batch.deadlineAt), (state.startedAt ?? Date.now()) + wallLimit);
  for (const id of ids) {
    options.signal.throwIfAborted();
    const check = batch.profile.commands.find(value => value.id === id)!;
    // Child identity is bounded and stays stable across durable trace reconstruction.
    const call: ToolCall = { id: `verify:${sha256(`${batch.id}:${parentCallId}`)}:${id}`, name: 'terminal', input: { command: check.command, args: check.args, cwd: check.cwd, timeoutMs: check.timeoutMs, verification: { kind: check.kind, scope: check.scope, profileId: check.id, batchId: batch.id } } };
    const maximum = options.loopBudget?.maxToolCalls ?? DEFAULT_AGENT_LOOP_RESOURCE_BUDGET.maxToolCalls;
    if (maximum !== undefined && state.toolCalls >= maximum) throw Object.assign(new Error('Parent Run tool-call budget exhausted.'), { code: 'tool_budget_exhausted' });
    state.toolCalls++;
    await append(createAssistantMessage('', [call], undefined, { hostToolTrace: 'verification' }));
    let result: ToolResult;
    const budget = new AbortController();
    const timer = setTimeout(() => budget.abort(), Math.max(0, deadline - Date.now()));
    const childOptions = { ...options, signal: AbortSignal.any([options.signal, budget.signal]) };
    try {
      result = deadline <= Date.now()
        ? verificationResult(call, { callId: call.id, ok: false, code: 'budget_exhausted', content: 'Batch deadline elapsed before this check.' })
        : await (lifecycle?.execute(call, childOptions) ?? executeToolCall(call, state, childOptions));
    } catch (error) {
      if (!options.signal.aborted && budget.signal.aborted) {
        result = verificationResult(call, { callId: call.id, ok: false, code: 'budget_exhausted', content: 'Verification or parent Run deadline elapsed.' });
      } else {
      if (!options.signal.aborted) throw error;
      result = verificationResult(call, { callId: call.id, ok: false, code: 'cancelled', content: 'Verification check cancelled; no execution is automatically replayed.' });
      await append({ ...createToolMessage(result), metadata: { hostToolTrace: 'verification' } });
      options.emit({ type: 'tool.finished', id: call.id, result });
      throw error;
      }
    } finally { clearTimeout(timer); }
    if (budget.signal.aborted && !options.signal.aborted && result.code === 'cancelled') {
      result = { ...result, code: 'budget_exhausted', ...(result.verification ? { verification: { ...result.verification, status: 'skipped', reason: 'budget_exhausted' } } : {}) };
      options.emit({ type: 'tool.finished', id: call.id, result });
    }
    await append({ ...createToolMessage(result), metadata: { hostToolTrace: 'verification' } });
    await lifecycle?.after?.(call, result);
    results.push(result);
  }
  return results;
}
