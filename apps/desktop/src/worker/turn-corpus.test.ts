import { createHash } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpeechProviderError, type SpeechAsrProvider } from '@desktop-agent/contracts';
import { evaluatePreparedTurnCorpus, prepareTurnCorpus, replayEndpointClip, type TurnReplayClock } from '../../../../scripts/evaluate-speech-turns';

function clock() {
  let time = 0;
  return { now: () => time, waitUntil: async (target: number, signal: AbortSignal) => { signal.throwIfAborted(); time = Math.max(time, target); }, advance: (ms: number) => { time += ms; } } satisfies TurnReplayClock & { advance(ms: number): void };
}
function wav(ms = 2000): Buffer {
  const bytes = Buffer.alloc(44 + ms * 32);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8); bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(ms * 32, 40);
  return bytes;
}
const signal = () => new AbortController().signal;
const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); });
async function corpus(options: { label?: boolean; physical?: boolean; consent?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jojo-turn-corpus-')); folders.push(root);
  const bytes = wav(), sha256 = createHash('sha256').update(bytes).digest('hex');
  const recording = { id: 'question', wav: 'question.wav', status: 'available', provenance: options.physical ? 'target_device_recording' : 'reference_recording',
    consentConfirmed: options.consent ?? false, environmentId: 'test-mac', language: 'zh',
    ...(options.label ? { endpoint: { kind: 'turn', audioSha256: sha256, speechEndMs: 1000, maxLatencyMs: 500 } } : {}) };
  const manifest = { version: 1, endpointEvaluation: { requiredIds: ['question'], thresholds: null }, recordings: [recording] };
  const file = path.join(root, 'manifest.json');
  await writeFile(path.join(root, 'question.wav'), bytes); await writeFile(file, JSON.stringify(manifest));
  return { root, file, manifest };
}
describe('paced endpoint replay', () => {
  it('excludes startup, includes inference, and drains already captured samples through endpoint time', async () => {
    const timer = clock(), captured: number[] = [];
    const provider: SpeechAsrProvider = { recognize: async function* (input) {
      timer.advance(1200); yield { type: 'ready', requestId: input.requestId };
      for await (const bytes of input.audio) {
        captured.push(bytes.length);
        if (captured.length === 1) {
          timer.advance(310); yield { type: 'endpoint', requestId: input.requestId, reason: 'smart_turn' };
        }
      }
      timer.advance(25); yield { type: 'final', requestId: input.requestId, text: '私密文字不得输出' };
    } };
    const observed = await replayEndpointClip({ provider, pcm: new Uint8Array(2000 * 32), signal: signal(), clock: timer });
    expect(observed).toMatchObject({ readyMs: 1200, endpoint: { atMs: 510, processedAudioMs: 200, reason: 'smart_turn' }, deliveredAudioMs: 510, replayMs: 535, finalReceived: true });
    expect(captured).toEqual([6400, 6400, 3520]);
    expect(JSON.stringify(observed)).not.toContain('私密');
  });
  it('runs through the full labeled horizon without treating an empty noise transcript as a process failure', async () => {
    let total = 0;
    const provider: SpeechAsrProvider = { recognize: async function* (input) {
      yield { type: 'ready', requestId: input.requestId };
      for await (const bytes of input.audio) total += bytes.length;
      throw new SpeechProviderError('empty_result', 'Private model message');
    } };
    expect(await replayEndpointClip({ provider, pcm: new Uint8Array(2000 * 32), signal: signal(), clock: clock() })).toMatchObject({ endpoint: null, deliveredAudioMs: 2000, emptyTranscript: true, finalReceived: false });
    expect(total).toBe(64000);
  });
  it.each(['early_final', 'duplicate_endpoint', 'wrong_identity', 'process_error', 'no_final'] as const)('rejects %s instead of scoring it as a missing endpoint', async kind => {
    const provider: SpeechAsrProvider = { recognize: async function* (input) {
      yield { type: 'ready', requestId: kind === 'wrong_identity' ? 'stale' : input.requestId };
      if (kind === 'early_final') { yield { type: 'final', requestId: input.requestId, text: 'early' }; return; }
      for await (const bytes of input.audio) {
        expect(bytes.byteLength).toBeGreaterThan(0);
        if (kind === 'duplicate_endpoint') { yield { type: 'endpoint', requestId: input.requestId, reason: 'smart_turn' }; yield { type: 'endpoint', requestId: input.requestId, reason: 'smart_turn' }; }
        if (kind === 'process_error') throw new SpeechProviderError('protocol_error', 'Disconnected');
      }
    } };
    await expect(replayEndpointClip({ provider, pcm: new Uint8Array(6400), signal: signal(), clock: clock() })).rejects.toThrow();
  });
  it('cancels a pending paced frame before sending more audio', async () => {
    const controller = new AbortController(); let frames = 0;
    const provider: SpeechAsrProvider = { recognize: async function* (input) {
      yield { type: 'ready', requestId: input.requestId };
      for await (const bytes of input.audio) { expect(bytes.byteLength).toBeGreaterThan(0); frames++; controller.abort(); }
    } };
    await expect(replayEndpointClip({ provider, pcm: new Uint8Array(12800), signal: controller.signal, clock: clock() })).rejects.toMatchObject({ code: 'cancelled' });
    expect(frames).toBe(1);
  });
});
describe('local corpus ingestion', () => {
  it('loads numeric WAV metadata, binds annotation to its hash, and keeps references out of physical metrics', async () => {
    const input = await corpus({ label: true });
    const prepared = await prepareTurnCorpus(input.file);
    expect(prepared.recordings[0]!.result).toMatchObject({ status: 'ready', durationMs: 2000, physicalChineseEvidence: false });
    const provider: SpeechAsrProvider = { recognize: async function* (capture) {
      yield { type: 'ready', requestId: capture.requestId };
      let total = 0;
      for await (const bytes of capture.audio) {
        total += bytes.length;
        if (total === 1200 * 32) yield { type: 'endpoint', requestId: capture.requestId, reason: 'smart_turn' };
      }
      yield { type: 'final', requestId: capture.requestId, text: 'private transcript' };
    } };
    const report = await evaluatePreparedTurnCorpus(prepared, { provider, signal: signal(), clock: clock() });
    expect(report.cases[0]).toMatchObject({ status: 'measured', score: { outcome: 'on_time', latencyMs: 200 } });
    expect(report.metrics.turnCases).toBe(0);
    expect(report.assessment.status).toBe('blocked');
    expect(JSON.stringify(report)).not.toContain(input.root);
    expect(JSON.stringify(report)).not.toContain('private transcript');
  });
  it('does not read a physical recording without recorded consent', async () => {
    const input = await corpus({ physical: true });
    expect((await prepareTurnCorpus(input.file)).recordings[0]!.result).toMatchObject({ status: 'blocked', issues: ['recording_consent_missing'] });
  });
  it('blocks annotation mismatch and clips missing the labeled observation horizon', async () => {
    const input = await corpus({ label: true });
    input.manifest.recordings[0]!.endpoint!.audioSha256 = 'b'.repeat(64);
    await writeFile(input.file, JSON.stringify(input.manifest));
    expect((await prepareTurnCorpus(input.file)).recordings[0]!.result.issues).toContain('annotation_audio_mismatch');
    input.manifest.recordings[0]!.endpoint!.audioSha256 = createHash('sha256').update(wav()).digest('hex');
    input.manifest.recordings[0]!.endpoint!.maxLatencyMs = 1500;
    await writeFile(input.file, JSON.stringify(input.manifest));
    expect((await prepareTurnCorpus(input.file)).recordings[0]!.result.issues).toContain('insufficient_labeled_audio');
  });
  it('rejects a symlink outside the corpus directory', async () => {
    const input = await corpus(), outside = await corpus();
    await rm(path.join(input.root, 'question.wav'));
    await symlink(path.join(outside.root, 'question.wav'), path.join(input.root, 'question.wav'));
    expect((await prepareTurnCorpus(input.file)).recordings[0]!.result).toMatchObject({ status: 'blocked', issues: ['audio_path_outside_corpus'] });
  });
  it('rechecks the WAV hash before replay and never loads a provider for a changed file', async () => {
    const input = await corpus({ label: true }), prepared = await prepareTurnCorpus(input.file);
    const changed = wav(); changed[44] = 1; await writeFile(path.join(input.root, 'question.wav'), changed);
    const recognize = vi.fn();
    const report = await evaluatePreparedTurnCorpus(prepared, { provider: { recognize }, signal: signal(), clock: clock() });
    expect(report.cases[0]).toMatchObject({ status: 'error', issues: expect.arrayContaining(['replay_failed']) });
    expect(recognize).not.toHaveBeenCalled();
    expect(report.metrics.turnCases).toBe(0);
  });
});
