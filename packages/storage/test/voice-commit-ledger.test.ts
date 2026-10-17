import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteSpeechAssetStore } from '../src/sqlite-speech-asset-store.js';
import { SqliteVoiceCommitLedger, type VoiceCommitInput } from '../src/voice-commit-ledger.js';

const directories: string[] = [];
function filename() { const directory = mkdtempSync(path.join(os.tmpdir(), 'voice-ledger-')); directories.push(directory); return path.join(directory, 'speech.sqlite'); }
const input: VoiceCommitInput = { voiceSessionId: 'session-a', voiceTurnId: 'turn-a', sessionId: 'session-a', generation: 1, text: '下一句不能丢失', providerId: 'offline', model: 'offline-model' };
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('durable voice commit reservations', () => {
  it('preserves the same run, payload and final state after reopening the shared asset database', async () => {
    const file = filename(); const assets = new SqliteSpeechAssetStore(file);
    let ledger = new SqliteVoiceCommitLedger(file, () => 10);
    const first = ledger.reserve(input); expect(first.created).toBe(true); expect(first.record.state).toBe('pending');
    ledger.transition(input.voiceTurnId, 1, 'pending', 'submitting'); ledger.transition(input.voiceTurnId, 1, 'submitting', 'committed');
    ledger.close(); ledger = new SqliteVoiceCommitLedger(file);
    const replay = ledger.reserve(input); expect(replay.created).toBe(false); expect(replay.record.runId).toBe(first.record.runId); expect(replay.record.state).toBe('committed');
    expect(replay.record.text).toBe(input.text); expect(replay.record.inputHash).toMatch(/^[0-9a-f]{64}$/u);
    await assets.find(`sha256:${'a'.repeat(64)}`, { kind: 'session', id: input.sessionId }); ledger.close(); assets.close();
  });
  it.each(['text','sessionId','voiceSessionId','providerId','model'] as const)('rejects changed %s for an existing reservation', (field) => {
    const ledger = new SqliteVoiceCommitLedger(filename()); const first = ledger.reserve(input);
    expect(() => ledger.reserve({ ...input, [field]: 'changed' })).toThrow('voice_commit_conflict');
    expect(ledger.get(input.voiceTurnId, 1)).toEqual(first.record); ledger.close();
  });
  it('preserves pending drafts and allocates a separate run for a new generation', () => {
    const file = filename(); let ledger = new SqliteVoiceCommitLedger(file);
    const first = ledger.reserve(input).record; ledger.close(); ledger = new SqliteVoiceCommitLedger(file);
    expect(ledger.get(input.voiceTurnId, 1)?.text).toBe(input.text);
    const next = ledger.reserve({ ...input, generation: 2, text: '新句子' }).record;
    expect(next.runId).not.toBe(first.runId); ledger.close();
  });
  it('does not permit terminal records to be submitted again and deletes only the requested session', () => {
    const ledger = new SqliteVoiceCommitLedger(filename()); ledger.reserve(input);
    ledger.reserve({ ...input, voiceTurnId: 'other', sessionId: 'other' });
    ledger.transition(input.voiceTurnId, 1, 'pending', 'failed', 'run_start_failed');
    expect(() => ledger.transition(input.voiceTurnId, 1, 'failed', 'submitting')).toThrow('voice_commit_invalid_transition');
    expect(ledger.reserve(input).record.errorCode).toBe('run_start_failed');
    ledger.deleteSession(input.sessionId); expect(ledger.get(input.voiceTurnId, 1)).toBeUndefined(); expect(ledger.get('other', 1)).toBeDefined(); ledger.close();
  });
  it('rejects a future component schema without relabeling or changing its journal', () => {
    const file = filename(); const db = new DatabaseSync(file);
    db.exec("CREATE TABLE speech_voice_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO speech_voice_meta VALUES ('schema_version','2');"); db.close();
    expect(() => new SqliteVoiceCommitLedger(file)).toThrow('voice_commit_schema_unsupported');
    const reopened = new DatabaseSync(file); expect(reopened.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('delete');
    expect(reopened.prepare('SELECT value FROM speech_voice_meta').get()?.value).toBe('2'); reopened.close();
  });
  it('rejects oversized or empty input before reservation', () => {
    const ledger = new SqliteVoiceCommitLedger(filename());
    expect(() => ledger.reserve({ ...input, text: ' '.repeat(2) })).toThrow(); expect(() => ledger.reserve({ ...input, text: '字'.repeat(20_001) })).toThrow();
    expect(ledger.get(input.voiceTurnId, 1)).toBeUndefined(); ledger.close();
  });
  it('gives only one writer a pending claim and rejects stale recovery transitions', () => {
    const file = filename(); const first = new SqliteVoiceCommitLedger(file); const second = new SqliteVoiceCommitLedger(file);
    const pending = first.reserve(input).record;
    const a = first.claim(pending); const b = second.claim(pending);
    expect(a.claimed).toBe(true); expect(b.claimed).toBe(false); expect(b.record.runId).toBe(a.record.runId);
    const recovered = first.transition(input.voiceTurnId, 1, 'submitting', 'pending', undefined, a.record.revision);
    const next = first.claim(recovered); expect(next.claimed).toBe(true);
    const stale = second.transition(input.voiceTurnId, 1, 'submitting', 'pending', undefined, a.record.revision);
    expect(stale.state).toBe('submitting'); expect(stale.revision).toBe(next.record.revision);
    first.close(); second.close();
  });
});
