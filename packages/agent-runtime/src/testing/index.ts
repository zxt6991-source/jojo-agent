import type { ApprovalRequest, Message, ModelProvider, PermissionGate, Tool } from '@desktop-agent/contracts';
import type { RuntimeEventEnvelope } from '@desktop-agent/contracts/runtime';
import { MemoryAgentRuntimeStore } from '../memory-store.js';
import { createAgentRuntime, type AgentRuntime, type ApprovalBroker } from '../public/runtime.js';

export { ScriptedProvider } from '@desktop-agent/agent';
export { MemoryAgentRuntimeStore } from '../memory-store.js';
export { verifyRuntimeContract } from './contract-suite.js';
export type { RuntimeContractReport, RuntimeContractRequest } from './contract-suite.js';

const allowPermissions: PermissionGate = {
  check: async () => ({ decision: 'allow' })
};

export class DeterministicApprovalBroker implements ApprovalBroker {
  readonly requests: ApprovalRequest[] = [];

  constructor(private readonly policy: boolean | ReadonlySet<string>) {}

  async requestApproval(request: ApprovalRequest): Promise<boolean> {
    this.requests.push(structuredClone(request));
    return typeof this.policy === 'boolean' ? this.policy : this.policy.has(request.call.name);
  }
}

export class RuntimeEventCollector {
  readonly events: RuntimeEventEnvelope[] = [];
  readonly listener = (event: RuntimeEventEnvelope): void => { this.events.push(event); };
}

export type TestRuntimeOptions = {
  provider: ModelProvider;
  tools?: Tool[] | (() => Tool[]);
  permissions?: PermissionGate;
  approvals?: 'allow' | 'deny' | readonly string[];
  idGenerator?: () => string;
  now?: () => Date;
};

export type TestRuntime = {
  runtime: AgentRuntime;
  store: MemoryAgentRuntimeStore;
  events: RuntimeEventCollector;
  approvals: DeterministicApprovalBroker;
};

export function createTestRuntime(options: TestRuntimeOptions): TestRuntime {
  const store = new MemoryAgentRuntimeStore();
  const events = new RuntimeEventCollector();
  const approvalPolicy = options.approvals === 'allow'
    ? true
    : options.approvals === 'deny' || options.approvals === undefined
      ? false
      : new Set(options.approvals);
  const approvals = new DeterministicApprovalBroker(approvalPolicy);
  const runtime = createAgentRuntime({
    store,
    ...(options.idGenerator ? { idGenerator: options.idGenerator } : {}),
    ...(options.now ? { now: options.now } : {}),
    environment: {
      host: { kind: 'test' },
      providers: { resolve: () => options.provider },
      tools: {
        resolve: () => ({
          snapshot: () => typeof options.tools === 'function' ? options.tools() : options.tools ?? []
        })
      },
      permissions: options.permissions ?? allowPermissions,
      approval: approvals
    }
  });
  runtime.subscribe(events.listener);
  return { runtime, store, events, approvals };
}

/** Seeds an empty lane for tests without adding history callbacks to RunRequest. */
export async function seedLane(
  target: TestRuntime,
  input: { sessionId: string; laneId?: string; messages: Message[] }
): Promise<void> {
  const session = await target.runtime.openSession({ id: input.sessionId, executionScope: { kind: 'none' } });
  const laneId = input.laneId ?? 'main';
  if (!(await session.listLanes()).some((lane) => lane.id === laneId)) {
    await session.createLane({ id: laneId });
  }
  let lane = await target.store.getLane(input.sessionId, laneId);
  if (!lane) throw new Error(`runtime_lane_not_found: ${laneId}`);
  for (const message of input.messages) {
    await target.store.appendEntry({
      id: message.id,
      sessionId: input.sessionId,
      parentId: lane.leafId,
      type: 'message',
      message
    });
    lane = { ...lane, leafId: message.id };
    await target.store.saveLane(lane);
  }
}

export type { ModelProvider } from '@desktop-agent/contracts';
export type { AgentRuntime } from '../public/runtime.js';
