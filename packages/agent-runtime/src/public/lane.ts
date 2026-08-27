import type { LaneSnapshot } from '@desktop-agent/contracts/runtime';
import type { RunHandle, RunRequest } from './run.js';

export interface RuntimeLane {
  readonly id: string;
  readonly sessionId: string;
  run(request: RunRequest): Promise<RunHandle>;
  cancelActiveRun(reason?: string): Promise<void>;
  getSnapshot(): Promise<LaneSnapshot>;
}

