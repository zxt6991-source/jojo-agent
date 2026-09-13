import { ServerApprovalBroker } from '@desktop-agent/app-service';
import { appendFileSync, closeSync, fsyncSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ScriptedProvider } from '@desktop-agent/agent-runtime/testing';
import { ServerDataOwnership, SqliteAgentRuntimeStore, SqliteServerStateStore } from '@desktop-agent/storage';
import { createHeadlessServer } from '../src/index.js';
import type { RequestContext } from '@desktop-agent/server-protocol';

const [directory, mode, point] = process.argv.slice(2) as [string, string, string];
const context: RequestContext = { requestId: 'test', principal: { id: 'test', type: 'local', scopes: ['admin'] } };
function checkpoint(name: string): void {
  if (name !== point) return;
  process.send?.({ checkpoint: name });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

async function main() {
  const ownership = ServerDataOwnership.acquire(directory);
  const store = new SqliteAgentRuntimeStore(path.join(directory, 'runtime.sqlite'));
  const stateStore = new SqliteServerStateStore(path.join(directory, 'server-state.sqlite'));
  // Test-only injection around real durable commits, including a synchronous transaction window.
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function(sql: string) {
    const statement = prepare.call(this, sql);
    if (sql.startsWith('UPDATE operations SET state_json')) {
      const run = statement.run.bind(statement);
      statement.run = ((...args: unknown[]) => {
        const result = Reflect.apply(run, undefined, args);
        if (String(args[0]).includes('runtime_interrupted')) checkpoint('terminal_update');
        return result;
      }) as typeof statement.run;
    }
    return statement;
  };
  const accepted = stateStore.runs.createAccepted;
  stateStore.runs.createAccepted = async input => { const result = await accepted(input); checkpoint('accepted'); return result; };
  const interrupted = stateStore.runs.markInterrupted;
  stateStore.runs.markInterrupted = async (...args) => { const result = await interrupted(...args); checkpoint('business_updated'); return result; };
  const pending = stateStore.approvals.createPending;
  stateStore.approvals.createPending = async input => { const result = await pending(input); checkpoint('approval'); return result; };
  const start = store.startOperation.bind(store);
  store.startOperation = async (...args) => { await start(...args); checkpoint('operation_started'); };
  const save = store.saveOperationState.bind(store);
  store.saveOperationState = async (...args) => {
    await save(...args);
    if (args[0].phase === 'model_pending') checkpoint('model_pending');
    if (args[0].phase === 'tools' && args[0].calls.some(call => call.status === 'effect_pending')) checkpoint('effect_pending');
    if (args[0].phase === 'failed' && args[0].error.code === 'runtime_interrupted') checkpoint('terminal_committed');
  };
  const append = store.appendEntry.bind(store);
  store.appendEntry = async input => {
    const result = await append(input);
    if (input.type === 'message' && input.message.role === 'assistant') checkpoint('assistant_entry');
    if (input.type === 'message' && input.message.role === 'tool') checkpoint(mode === 'seed' ? 'result_entry' : 'recovery_result');
    return result;
  };
  let providerCalls = 0;
  const host = await createHeadlessServer({
    ownership, store, stateStore, dataDir: directory, scheduler: false,
    providers: { resolve: () => { providerCalls++; return new ScriptedProvider(mode === 'seed' ? [
      [{ type: 'tool_call_completed', call: { id: 'call', name: 'effect', input: {} } }, { type: 'response_completed', stopReason: 'tool_calls' }],
      [{ type: 'text_delta', text: 'done' }, { type: 'response_completed', stopReason: 'stop' }]
    ] : [[{ type: 'text_delta', text: 'new response' }, { type: 'response_completed', stopReason: 'stop' }]]); } },
    permissions: { check: async call => point === 'approval' ? { decision: 'ask', request: { requestId: 'approval', sessionId: 's', call, reason: 'test' } } : { decision: 'allow' } },
    tools: { resolve: () => ({ snapshot: () => [{ definition: { name: 'effect', description: 'external counter', inputSchema: { type: 'object' } }, execute: async () => {
      const filename = path.join(directory, 'effects');
      appendFileSync(filename, 'effect\n'); const fd = openSync(filename, 'r'); fsyncSync(fd); closeSync(fd);
      checkpoint('effect_fsynced');
      return { callId: 'call', ok: true, content: 'effect persisted' };
    } }] }) }
  });
  if (mode === 'seed') {
    await host.runtime.openSession({ id: 's' });
    await stateStore.sessions.ensureActive({ sessionId: 's' });
    await host.appService.startRun(context, 's', { laneId: 'main', input: { content: [{ type: 'text', text: 'execute' }] }, providerId: 'p', model: 'm' }, { runId: 'old' });
    await new Promise<void>(() => undefined);
    return;
  }
  const approval = await stateStore.approvals.get('approval');
  let approvalReplayError: string | undefined;
  if (approval?.status === 'interrupted') {
    try { await new ServerApprovalBroker({ store: stateStore.approvals }).resolve('approval', 'allow'); }
    catch (error) { approvalReplayError = String(error); }
  }
  const recoveredProviderCalls = providerCalls;
  const old = await stateStore.runs.list('s');
  const operation = await store.loadOperation('old');
  const detail = operation?.state.phase === 'failed' ? operation.state.error.detail as { leafId?: string } : undefined;
  const entries = await store.readPath(detail?.leafId ?? null);
  const ids = entries.map(entry => entry.id);
  let effects = 0;
  try { effects = readFileSync(path.join(directory, 'effects'), 'utf8').trim().split('\n').length; } catch { /* No external effect yet. */ }
  const next = await host.appService.startRun(context, 's', { laneId: 'main', input: { content: [{ type: 'text', text: 'continue' }] }, providerId: 'p', model: 'm' });
  let result = await host.appService.getRun(context, 's', next.id);
  while (result.status === 'starting' || result.status === 'running' || result.status === 'accepted') {
    await new Promise(resolve => setImmediate(resolve));
    result = await host.appService.getRun(context, 's', next.id);
  }
  const db = new DatabaseSync(path.join(directory, 'runtime.sqlite'));
  const integrity = db.prepare('PRAGMA integrity_check').get(); db.close();
  process.send?.({ approvalReplayError, recoveredProviderCalls, old, ids, entries, effects, result, integrity });
  await host.close(); store.close();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
