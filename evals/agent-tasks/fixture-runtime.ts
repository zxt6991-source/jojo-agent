import { performance } from 'node:perf_hooks';
import { createAgentRuntime, type ApprovalBroker, type RunBudget, type AgentRuntime } from '@desktop-agent/agent-runtime';
import { describeTestProvider, MemoryAgentRuntimeStore } from '@desktop-agent/agent-runtime/testing';
import type { AgentRuntimeStore } from '@desktop-agent/agent-runtime/spi';
import type { ModelProvider, Tool, ToolResult, PermissionGate, Message } from '@desktop-agent/contracts';
import type { RunResult, RuntimeEventEnvelope } from '@desktop-agent/contracts/runtime';

export type Criterion = { id: string; passed: boolean | null; evidence: string; reason?: string };
export type Scenario = {
  root: string; taskId: string; timeoutMs: number; provider: ModelProvider; tools: Tool[];
  permissions: PermissionGate; approval?: ApprovalBroker; signal?: AbortSignal; budget?: RunBudget;
  store?: AgentRuntimeStore; beforeRun?: (runtime: AgentRuntime) => Promise<void>;
  observe?: (event: RuntimeEventEnvelope) => void;
  verify: (result: RunResult, tools: ToolResult[], messages: Message[]) => Promise<{ criteria: Criterion[]; evidence: Record<string, unknown>; expectedStatus?: RunResult['status'] }>;
};

/** Every score derives from the durable ledger and independent checks, including cancelled runs. */
export async function executeScenario(scenario: Scenario) {
  const store = scenario.store ?? new MemoryAgentRuntimeStore();
  const events: RuntimeEventEnvelope[] = [];
  let modelCalls = 0;
  let userTurns = 0;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const start = performance.now();
  const runtime = createAgentRuntime({ store, environment: {
    host: { kind: 'test' }, providers: { describe: describeTestProvider, resolve: () => ({ async *stream(request) { modelCalls++; yield* scenario.provider.stream(request); } }) },
    tools: { resolve: () => ({ snapshot: () => scenario.tools }) }, permissions: scenario.permissions,
    ...(scenario.approval ? { approval: scenario.approval } : {})
  } });
  runtime.subscribe(event => { events.push(event); scenario.observe?.(event); });
  const sessionId = `offline-${scenario.taskId}`;
  const readMessages = async () => {
    const lane = await store.getLane(sessionId, 'main');
    if (!lane?.leafId) return [];
    return (await store.readPath(lane.leafId)).flatMap(entry => entry.type === 'message' ? [entry.message] : []);
  };
  try {
    const session = await runtime.openSession({ id: sessionId, executionScope: { kind: 'workspace', workingDirectory: scenario.root } });
    await scenario.beforeRun?.(runtime);
    userTurns++;
    const handle = await (await session.getLane()).run({ trigger: { kind: 'user' }, input: `Execute the controlled ${scenario.taskId} fixture.`, providerId: 'offline-scripted', model: 'fixture-v1', ...(scenario.signal ? { signal: scenario.signal } : {}), ...(scenario.budget ? { budget: scenario.budget } : {}) });
    timer = setTimeout(() => { timedOut = true; void handle.cancel('offline fixture timeout'); }, scenario.timeoutMs);
    const result = await handle.result;
    clearTimeout(timer);
    const messages = await readMessages();
    const results = messages.flatMap(message => message.content.flatMap(block => block.type === 'tool_result' ? [block.result] : []));
    const verification = await scenario.verify(result, results, messages);
    const passed = !timedOut && result.status === (verification.expectedStatus ?? 'completed') && verification.criteria.length > 0 && verification.criteria.every(item => item.passed === true);
    return {
      status: passed ? 'passed' : 'failed', ...(passed ? {} : { failureCategory: timedOut ? 'timeout' : 'fixture_assertion' }), criteria: verification.criteria,
      ...measurements(modelCalls, results.length, userTurns, performance.now() - start),
      trace: { mode: 'offline', runStatus: result.status, timedOut, finalText: result.finalText, events, toolResults: Object.fromEntries(results.map(result => [result.callId, result])), ...verification.evidence }
    };
  } catch (error) {
    if (timer) clearTimeout(timer);
    const messages = await readMessages();
    const results = messages.flatMap(message => message.content.flatMap(block => block.type === 'tool_result' ? [block.result] : []));
    return { status: 'infrastructure_error', failureCategory: 'fixture_execution', criteria: [{ id: 'fixture-execution', passed: null, reason: 'Runtime fixture could not complete.', evidence: 'trace.json#error' }],
      ...measurements(modelCalls, results.length, userTurns, performance.now() - start),
      trace: { mode: 'offline', timedOut, events, toolResults: Object.fromEntries(results.map(result => [result.callId, result])), error: error instanceof Error ? error.message : String(error) }
    };
  } finally { if (timer) clearTimeout(timer); await runtime.close(); }
}
function measurements(modelCalls: number, toolCalls: number, userTurns: number, elapsedMs: number) {
  return { modelCalls, toolCalls, userTurns, elapsedMs, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: 0,
    metricReasons: Object.fromEntries(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].map(name => [name, 'Offline scripted provider supplies no token usage.'])) };
}
