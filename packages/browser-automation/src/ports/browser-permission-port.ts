import type { BrowserRecordingDocument } from '@desktop-agent/contracts';

export type BrowserEffectSummary = {
  recordingId: string;
  domains: string[];
  effects: string[];
  includesSecrets: boolean;
};

export interface BrowserPermissionPort {
  approveRecording(recording: BrowserRecordingDocument, summary: BrowserEffectSummary, signal: AbortSignal): Promise<boolean>;
  assertNavigation(url: string, allowedDomains: ReadonlySet<string>): Promise<void>;
}
