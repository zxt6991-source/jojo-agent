import type { Message } from '@desktop-agent/contracts';
import type { LaneSnapshot } from '@desktop-agent/contracts/runtime';
import type { RunHandle, RunRequest } from './run.js';

export type TranscriptReadOptions = {
  cursor?: string;
  limit?: number;
};

export type RuntimeTranscriptPage = {
  items: Message[];
  nextCursor?: string;
};

export interface RuntimeLane {
  readonly id: string;
  readonly sessionId: string;
  run(request: RunRequest): Promise<RunHandle>;
  cancelActiveRun(reason?: string): Promise<void>;
  getSnapshot(): Promise<LaneSnapshot>;
  readTranscript(options?: TranscriptReadOptions): Promise<RuntimeTranscriptPage>;
}
