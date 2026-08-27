import type { LaneInfo, SessionSnapshot } from '@desktop-agent/contracts/runtime';
import type { RuntimeLane } from './lane.js';

export type CreateLaneRequest = {
  id: string;
  parentLaneId?: string;
};

export interface RuntimeSession {
  readonly id: string;
  getLane(id?: string): Promise<RuntimeLane>;
  createLane(request: CreateLaneRequest): Promise<RuntimeLane>;
  listLanes(): Promise<LaneInfo[]>;
  getSnapshot(): Promise<SessionSnapshot>;
}

