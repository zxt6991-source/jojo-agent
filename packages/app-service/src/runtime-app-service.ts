import type {
  AgentRuntime,
  OpenSessionRequest,
  RunHandle,
  RunRequest,
  RuntimeEventListener
} from '@desktop-agent/agent-runtime';
import type { LaneSnapshot, RunResult, SessionSnapshot } from '@desktop-agent/contracts/runtime';

export type StartedRuntimeRun = {
  id: string;
  result: Promise<RunResult>;
};

export interface RuntimeAppService {
  openSession(request: OpenSessionRequest): Promise<SessionSnapshot>;
  getSession(sessionId: string): Promise<SessionSnapshot | undefined>;
  run(sessionId: string, laneId: string | undefined, request: RunRequest): Promise<StartedRuntimeRun>;
  cancel(runId: string, reason?: string): Promise<boolean>;
  getLane(sessionId: string, laneId?: string): Promise<LaneSnapshot | undefined>;
  subscribe(listener: RuntimeEventListener): () => void;
  close(): Promise<void>;
}

class DefaultRuntimeAppService implements RuntimeAppService {
  private readonly runs = new Map<string, RunHandle>();

  constructor(private readonly runtime: AgentRuntime) {}

  async openSession(request: OpenSessionRequest): Promise<SessionSnapshot> {
    return (await this.runtime.openSession(request)).getSnapshot();
  }

  async getSession(sessionId: string): Promise<SessionSnapshot | undefined> {
    return (await this.runtime.getSession(sessionId))?.getSnapshot();
  }

  async run(sessionId: string, laneId: string | undefined, request: RunRequest): Promise<StartedRuntimeRun> {
    const session = await this.runtime.getSession(sessionId);
    if (!session) throw new Error(`runtime_session_not_found: ${sessionId}`);
    const lane = await session.getLane(laneId);
    const handle = await lane.run(request);
    this.runs.set(handle.id, handle);
    const result = handle.result.finally(() => this.runs.delete(handle.id));
    return { id: handle.id, result };
  }

  async cancel(runId: string, reason?: string): Promise<boolean> {
    const handle = this.runs.get(runId);
    if (!handle) return false;
    await handle.cancel(reason);
    return true;
  }

  async getLane(sessionId: string, laneId = 'main'): Promise<LaneSnapshot | undefined> {
    const session = await this.runtime.getSession(sessionId);
    if (!session) return undefined;
    try { return await (await session.getLane(laneId)).getSnapshot(); }
    catch { return undefined; }
  }

  subscribe(listener: RuntimeEventListener): () => void {
    return this.runtime.subscribe(listener);
  }

  close(): Promise<void> {
    return this.runtime.close();
  }
}

export function createRuntimeAppService(runtime: AgentRuntime): RuntimeAppService {
  return new DefaultRuntimeAppService(runtime);
}
