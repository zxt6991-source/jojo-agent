import { VerificationRequestSchema, type ApprovalRequest, type Message, type Tool, type WorkspaceRevision } from '@desktop-agent/contracts';
import type { AgentRunOptions } from './types.js';
/** Pure orchestration over a trusted Host evidence port; no filesystem dependency. */
export async function captureVerificationRevisions(messages: readonly Message[], tools: readonly Tool[], options: Pick<AgentRunOptions, 'workingDirectory' | 'signal'>): Promise<WorkspaceRevision[]> {
  const capture = tools.find(tool => tool.captureWorkspaceRevision)?.captureWorkspaceRevision;
  if (!capture) return [];
  const scopes = new Map<string, WorkspaceRevision>();
  for (const message of messages) for (const block of message.content) {
    if (block.type !== 'tool_result') continue;
    const revision = block.result.verification?.revisionBefore;
    if (revision) scopes.set(`${revision.workspaceId}:${revision.scopeHash}`, revision);
  }
  const results: WorkspaceRevision[] = [];
  for (const revision of [...scopes.values()].slice(-20)) results.push(await capture({ workingDirectory: options.workingDirectory, inputs: revision.inputs, signal: options.signal }));
  return results;
}
export async function requestToolApproval(options: AgentRunOptions, request: ApprovalRequest): Promise<{ allowed: boolean; code?: string }> {
  const input = request.call.input;
  const metadata = request.call.name === 'terminal' && input && typeof input === 'object' && 'verification' in input ? VerificationRequestSchema.safeParse(input.verification) : undefined;
  const id = metadata?.success ? metadata.data.batchId : undefined;
  if (!id) return { allowed: await options.approve(request, options.signal) };
  const batch = await options.readVerificationBatch?.(id);
  if (!batch) return { allowed: false, code: 'verification_batch_invalid' };
  const remaining = Date.parse(batch.deadlineAt) - Date.now();
  if (remaining <= 0) return { allowed: false, code: 'budget_exhausted' };
  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(), remaining);
  try {
    const allowed = await options.approve(request, AbortSignal.any([options.signal, budget.signal]));
    return budget.signal.aborted ? { allowed: false, code: 'budget_exhausted' } : { allowed };
  } catch (error) {
    options.signal.throwIfAborted();
    if (budget.signal.aborted) return { allowed: false, code: 'budget_exhausted' };
    throw error;
  } finally { clearTimeout(timer); }
}
