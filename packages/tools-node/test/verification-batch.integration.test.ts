import { describeTestProvider } from '@desktop-agent/agent-runtime/testing';
import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAgentTurn } from '@desktop-agent/agent';
import { createAgentRuntime } from '@desktop-agent/agent-runtime';
import { MemoryAgentRuntimeStore } from '@desktop-agent/agent-runtime/spi';
import { verificationFacts, NoopHookRuntime, type HookRuntime, type ModelProvider, type Message, type ToolResult } from '@desktop-agent/contracts';
import { createDefaultToolRuntime } from '../src/index.js';
async function fixture(budgetMs = 10000) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'verification-batch-'));
  await mkdir(path.join(root, '.jojo'));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/a.ts'), 'export const a = 1;');
  await writeFile(path.join(root, '.jojo/verification.json'), JSON.stringify({ version: 2, inputs: { include: ['src/**'] }, budgetMs, commands: ['lint', 'typecheck', 'test'].map(kind => ({ id: kind, kind, command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: '.', scope: 'src' })) }));
  return root;
}
const scripted: ModelProvider = { async *stream(request) {
  expect(request.messages.some(message => message.metadata?.hostToolTrace)).toBe(false);
  const pending = new Set<string>();
  for (const message of request.messages) {
    if (message.role === 'assistant') expect(pending.size).toBe(0);
    for (const block of message.content) {
      if (block.type === 'tool_call') pending.add(block.call.id);
      if (block.type === 'tool_result') { expect(pending.has(block.result.callId)).toBe(true); pending.delete(block.result.callId); }
    }
  }
  expect(pending.size).toBe(0);
  const results = request.messages.flatMap(message => message.content.flatMap(block => block.type === 'tool_result' ? [block.result] : []));
  const batch = results.find(result => result.verificationBatch)?.verificationBatch;
  if (!batch) yield { type: 'tool_call_completed', call: { id: 'profile', name: 'verification_profile', input: {} } };
  else if (!results.some(result => result.callId === 'batch-run')) yield { type: 'tool_call_completed', call: { id: 'batch-run', name: 'verification_run', input: { batchId: batch.id } } };
  else { yield { type: 'text_delta', text: 'Checks settled.' }; yield { type: 'response_completed', stopReason: 'stop' }; return; }
  yield { type: 'response_completed', stopReason: 'tool_calls' };
} };
async function run(root: string, stallApproval = false, hooks?: HookRuntime) {
  const tools = createDefaultToolRuntime({ sandboxMode: 'off' });
  const store = new MemoryAgentRuntimeStore();
  const approvals: string[] = [];
  const runtime = createAgentRuntime({ store, environment: {
    ...(hooks ? { hooks } : {}), host: { kind: 'test' }, providers: { describe: describeTestProvider, resolve: () => scripted }, tools: { resolve: () => ({ snapshot: () => tools.tools }) },
    permissions: { check: (call, ctx) => tools.permissionGate.check(call, ctx) },
    approval: { requestApproval: async (request, _ctx, signal) => {
      approvals.push(request.call.name);
      if (stallApproval) return new Promise<boolean>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      return true;
    } }
  } });
  try {
    const session = await runtime.openSession({ id: 'verified', executionScope: { kind: 'workspace', workingDirectory: root } });
    const lane = await session.getLane();
    const result = await (await lane.run({ input: 'run profile', providerId: 'test', model: 'test' })).result;
    const stored = await store.getLane('verified', 'main');
    const messages = (await store.readPath(stored!.leafId)).flatMap(entry => entry.type === 'message' ? [entry.message] : []);
    return { result, messages, approvals };
  } finally { await runtime.close(); }
}
const results = (messages: Message[]): ToolResult[] => messages.flatMap(message => message.content.flatMap(block => block.type === 'tool_result' ? [block.result] : []));
describe('durable governed verification batch', () => {
  it('executes separately approved checks, persists revision evidence and keeps all three current', async () => {
    const f = await run(await fixture());
    expect(f.approvals).toEqual(['terminal', 'terminal', 'terminal']);
    const facts = verificationFacts(f.messages).filter(record => record.status === 'passed');
    expect(facts).toHaveLength(3);
    expect(facts.every(record => record.validity === 'current' && !record.stale)).toBe(true);
    expect(results(f.messages).find(result => result.callId === 'batch-run')).toMatchObject({ ok: true });
  });
  it('includes approval wait in the deadline and leaves later checks skipped without executing them', async () => {
    const f = await run(await fixture(1000), true);
    expect(f.approvals).toEqual(['terminal']);
    expect(results(f.messages).filter(result => result.verification).every(result => result.verification?.status === 'skipped' && result.code === 'budget_exhausted')).toBe(true);
    expect(results(f.messages).find(result => result.callId === 'batch-run')).toMatchObject({ ok: false });
  });
  it('applies PreToolUse and PostToolUse to each internal terminal check', async () => {
    const hooks: HookRuntime = Object.create(NoopHookRuntime.instance);
    const pre: string[] = [], post: string[] = [];
    hooks.configured = event => ['PreToolUse', 'PostToolUse'].includes(event);
    hooks.preToolUse = async payload => { pre.push(payload.toolName); return payload.toolName === 'terminal' ? { decision: 'block', reason: 'Fixture blocks verification effects.' } : { decision: 'neutral' }; };
    hooks.inject = async (_event, payload) => { if ('toolName' in payload) post.push(payload.toolName); return { additionalContext: '' }; };
    const f = await run(await fixture(), false, hooks);
    expect(pre.filter(name => name === 'terminal')).toHaveLength(3);
    expect(post.filter(name => name === 'terminal')).toHaveLength(3);
    expect(f.approvals).toEqual([]);
    expect(results(f.messages).filter(result => result.verification).every(result => result.code === 'hook_blocked')).toBe(true);
  });
  it('terminates an active check at the shared deadline and never starts later checks', async () => {
    const root = await fixture(1000);
    const profile = JSON.parse(await readFile(path.join(root, '.jojo/verification.json'), 'utf8'));
    profile.commands[0].args = ['-e', 'setTimeout(() => require("node:fs").writeFileSync("late-side-effect.txt", "unexpected"), 10000)'];
    await writeFile(path.join(root, '.jojo/verification.json'), JSON.stringify(profile));
    const started = Date.now();
    const f = await run(root);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(f.approvals).toEqual(['terminal']);
    expect(results(f.messages).filter(result => result.verification).every(result => result.code === 'budget_exhausted')).toBe(true);
    await expect(access(path.join(root, 'late-side-effect.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('counts internal checks against the parent tool-call budget', async () => {
    const root = await fixture(); const tools = createDefaultToolRuntime({ sandboxMode: 'off' });
    let approvals = 0;
    const f = await runAgentTurn({ sessionId: 'budget', workingDirectory: root, model: 'test', provider: scripted, tools: tools.tools, permissionGate: tools.permissionGate, history: [], userText: 'run profile', signal: new AbortController().signal, emit: () => undefined, approve: async () => { approvals++; return true; }, loopBudget: { maxToolCalls: 3 } });
    expect(approvals).toBe(1);
    expect(results(f.messages).find(result => result.callId === 'batch-run')).toMatchObject({ ok: false, code: 'tool_budget_exhausted' });
  });
});
