import type { AgentRuntime, RunResult } from '../public/index.js';
import type { RuntimeEventEnvelope } from '@desktop-agent/contracts/runtime';

export type RuntimeContractRequest = {
  sessionId: string;
  providerId: string;
  model: string;
};

export type RuntimeContractReport = {
  result: RunResult;
  events: RuntimeEventEnvelope[];
};

/**
 * Reusable behavior-level conformance check for Electron, Test, CLI, and
 * Server Hosts. The supplied Runtime must resolve a provider for one turn.
 */
export async function verifyRuntimeContract(
  runtime: AgentRuntime,
  request: RuntimeContractRequest
): Promise<RuntimeContractReport> {
  const events: RuntimeEventEnvelope[] = [];
  const unsubscribe = runtime.subscribe((event) => events.push(event));
  const session = await runtime.openSession({
    id: request.sessionId,
    executionScope: { kind: 'none' }
  });
  const lane = await session.getLane();
  const result = await (await lane.run({
    input: { content: [{ type: 'text', text: 'runtime contract probe' }] },
    providerId: request.providerId,
    model: request.model
  })).result;
  unsubscribe();

  if (result.status !== 'completed') {
    throw new Error(`runtime_contract_run_failed: ${result.error?.message ?? result.status}`);
  }
  if ((await lane.getSnapshot()).messageCount < 2) {
    throw new Error('runtime_contract_history_not_durable');
  }
  if (events[0]?.event.type !== 'run.started' || events.at(-1)?.event.type !== 'run.completed') {
    throw new Error('runtime_contract_event_sequence_invalid');
  }
  if (!events.every((event, index) => event.sequence === index + 1)) {
    throw new Error('runtime_contract_event_sequence_not_monotonic');
  }
  return { result, events };
}
