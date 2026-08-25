import type { BrowserRecordingStep } from '@desktop-agent/contracts';

export type BrowserReplayJournalState =
  | 'step_started'
  | 'step_effect_dispatched'
  | 'step_heal_proposed'
  | 'step_heal_verified'
  | 'step_verified'
  | 'step_failed'
  | 'run_completed';

export type BrowserReplayJournalOutputValue =
  | { type: 'file'; path: string }
  | { type: 'string'; value: string }
  | { type: 'json'; value: unknown };

export type BrowserReplayJournalEntry = {
  runId: string;
  recordingId: string;
  revision: number;
  stepId: string;
  stepIndex: number;
  action: BrowserRecordingStep['action'];
  state: BrowserReplayJournalState;
  timestamp: string;
  attempt?: number;
  selector?: string;
  confidence?: number;
  output?: { name: string; value: BrowserReplayJournalOutputValue };
};

export interface BrowserReplayJournalPort {
  append(entry: BrowserReplayJournalEntry): Promise<void>;
  read(runId: string): Promise<BrowserReplayJournalEntry[]>;
}
