import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateBrowserRecording } from '@desktop-agent/contracts';
import {
  BrowserRecordingRevisionHistoryStore,
  BrowserReplayJournalStore,
  createBrowserReplayJournalEntry,
  finalizeBrowserRecording
} from '../src';

function recording(revision = 1) {
  return finalizeBrowserRecording({
    ...migrateBrowserRecording({
      version: 1,
      id: 'studio-checkout',
      name: 'Studio Checkout',
      createdAt: '2026-08-26T00:00:00.000Z',
      params: [],
      steps: [{ action: 'click', selector: '#pay' }]
    }),
    revision,
    updatedAt: `2026-08-26T00:00:0${revision}.000Z`,
    description: `revision ${revision}`
  });
}

describe('Browser Automation Studio persistence', () => {
  it('archives immutable recording revisions and marks the current revision', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-browser-history-'));
    const store = new BrowserRecordingRevisionHistoryStore(directory);
    const first = recording(1);
    const second = recording(2);
    await store.archive(first);
    await store.archive(first);
    expect(await store.list(second)).toEqual([
      expect.objectContaining({ revision: 2, current: true, contentHash: second.contentHash }),
      expect.objectContaining({ revision: 1, current: false, contentHash: first.contentHash })
    ]);
  });

  it('lists replay debugger entries by recording and preserves heal state order', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-browser-journal-'));
    const store = new BrowserReplayJournalStore(directory);
    const base = {
      runId: 'brun_studio1234', recordingId: 'studio-checkout', revision: 2,
      stepId: 's1', stepIndex: 1, action: 'click' as const, attempt: 1
    };
    await store.append(createBrowserReplayJournalEntry({ ...base, state: 'step_heal_proposed', selector: '#pay-now', confidence: 0.92 }));
    await store.append(createBrowserReplayJournalEntry({ ...base, state: 'step_heal_verified', selector: '#pay-now', confidence: 0.92 }));
    await store.append(createBrowserReplayJournalEntry({ ...base, runId: 'brun_other1234', recordingId: 'other', state: 'step_verified' }));
    const entries = await store.list('studio-checkout');
    expect(entries.map((entry) => entry.state)).toEqual(['step_heal_proposed', 'step_heal_verified']);
    expect(entries[0]).toMatchObject({ selector: '#pay-now', confidence: 0.92 });
  });
});
