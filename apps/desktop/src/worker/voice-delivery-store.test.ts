import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { VoiceDeliveryLedger } from '@desktop-agent/speech';
import { SqliteVoiceDeliveryStore } from './voice-delivery-store';
it('recovers a played prefix and conservatively interrupts the segment playing at crash', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'voice-delivery-')); const filename = path.join(dir, 'speech.sqlite');
  let store = new SqliteVoiceDeliveryStore(filename);
  try {
    let ledger = new VoiceDeliveryLedger(store);
    const input = { voiceSessionId: 'session', turnId: 'turn', runId: 'run', generation: 1, messageId: 'display' };
    for (const [id, spokenText] of [['one', '听完的。'], ['two', '还没听完的。']]) {
      ledger.queue({ ...input, id: id!, spokenText: spokenText! });
      for (const state of ['synthesizing', 'ready', 'playing'] as const) ledger.transition(id!, 1, state);
    }
    ledger.transition('one', 1, 'played'); store.close(); store = new SqliteVoiceDeliveryStore(filename); ledger = new VoiceDeliveryLedger(store);
    expect(ledger.heardPrefix('run')).toBe('听完的。'); expect(ledger.snapshot()[1]?.state).toBe('interrupted');
    store.deleteSession('session'); expect(store.load()).toEqual([]);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
