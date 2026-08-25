import type { BrowserRecordingDocument } from '@desktop-agent/contracts';

export type BrowserRecordingWriteExpectation = {
  expectedRevision: number;
  expectedHash: string;
};

export interface BrowserRecordingStorePort {
  list(): Promise<BrowserRecordingDocument[]>;
  get(id: string): Promise<BrowserRecordingDocument>;
  save(document: BrowserRecordingDocument, expectation?: BrowserRecordingWriteExpectation): Promise<BrowserRecordingDocument>;
  delete(id: string): Promise<void>;
}
