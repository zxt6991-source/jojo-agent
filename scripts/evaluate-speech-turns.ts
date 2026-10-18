import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { SpeechProviderError, type SpeechAsrProvider, type SpeechEndpointReason } from '@desktop-agent/contracts';
import { parseTurnCorpus, scoreEndpoint, summarizeEndpointCorpus, type EndpointCaseResult, type TurnCorpus, type TurnCorpusRecording } from '@desktop-agent/speech';
import { createSpeechSidecarHost } from '../apps/desktop/src/worker/speech-sidecar-host';
import { StreamingSpeechAsr } from '../apps/desktop/src/worker/streaming-input';
import { parseStreamingPcmFixture } from './streaming-speech-smoke';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FRAME_BYTES = 6400, MAX_WAV_BYTES = 60 * 32_000 + 64 * 1024;
const HELP = `Check or replay the local Chinese turn corpus. No recording, playback, downloads or settings changes.

  pnpm speech:eval:turns --check
  pnpm speech:eval:turns --run --manifest /absolute/corpus/manifest.json

--check                 Default. Validate manifest, WAVs, hashes and labels without loading models.
--run                   Replay available clips at real-time speed through the production input adapter.
--manifest PATH         Default: tests/fixtures/speech/manifest.json
--report PATH           Explicitly save the same numeric JSON report to a new local file.
--python PATH           Default: .local-speech/venv/bin/python3
--vad PATH              Default: .local-speech/models/silero_vad.onnx
--paraformer PATH       Default: .local-speech/models/StreamingParaformer
--smart-turn PATH       Default: .local-speech/models/smart-turn-v3.1.onnx
--fallback-timeout-ms N  500..10000, default 3000
--help, -h              Show this help.

WAV paths are relative to the manifest directory; symlinks cannot escape it.
Use complete 16 kHz mono PCM16LE WAVs of at most 60 seconds. Physical recordings
require consentConfirmed=true. Labels bind to the SHA256 of the full WAV file.
A turn clip must include silence through speechEndMs + maxLatencyMs.

Replay excludes model startup from the audio clock, feeds 200 ms frames at their
right edge, includes inference/backpressure time, and drains captured PCM on stop.
This measures local file replay latency, not microphone/device or AEC latency.
Default stdout is JSON without paths, transcripts or audio. Exit 0 means complete
measurements met explicit corpus criteria; exit 2 means blocked/incomplete; exit 1
means invalid input, runtime failure or exceeded criteria. pnpm may normalize
nonzero script exits to 1. No release gate changes.
`;

async function boundedRead(file: string, limit: number): Promise<Uint8Array> {
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > limit) throw new Error('invalid_fixture_size');
    const bytes = new Uint8Array(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) throw new Error('fixture_changed');
      offset += result.bytesRead;
    }
    if ((await handle.stat()).size !== bytes.length) throw new Error('fixture_changed');
    return bytes;
  } finally { await handle.close(); }
}
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
interface PreparedRecording {
  spec: TurnCorpusRecording;
  file?: string;
  result: EndpointCaseResult & { audioSha256?: string; durationMs?: number };
}
export interface PreparedTurnCorpus { corpus: TurnCorpus; manifestSha256: string; recordings: PreparedRecording[] }
export async function prepareTurnCorpus(manifestFile: string): Promise<PreparedTurnCorpus> {
  const manifestBytes = await boundedRead(manifestFile, 256 * 1024);
  const corpus = parseTurnCorpus(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)));
  const root = await realpath(path.dirname(manifestFile));
  const recordings: PreparedRecording[] = [];
  for (const spec of corpus.recordings) {
    const physicalChineseEvidence = spec.provenance === 'target_device_recording' && spec.consentConfirmed === true && !!spec.environmentId && spec.language === 'zh';
    const result: PreparedRecording['result'] = { id: spec.id, status: spec.status === 'missing' ? 'missing' : 'ready', issues: [], physicalChineseEvidence };
    const item: PreparedRecording = { spec, result }; recordings.push(item);
    if (spec.status === 'missing') { result.issues.push('recording_missing'); continue; }
    if (!spec.provenance || spec.provenance === 'target_device_recording' && !spec.consentConfirmed) {
      result.status = 'blocked'; result.issues.push(spec.provenance ? 'recording_consent_missing' : 'recording_provenance_missing'); continue;
    }
    try {
      const file = await realpath(path.resolve(root, spec.wav)), relative = path.relative(root, file);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('audio_path_outside_corpus');
      const bytes = await boundedRead(file, MAX_WAV_BYTES), pcm = parseStreamingPcmFixture(bytes);
      result.audioSha256 = sha256(bytes); result.durationMs = pcm.byteLength / 32;
      if (spec.endpoint && spec.endpoint.audioSha256 !== result.audioSha256) { result.status = 'blocked'; result.issues.push('annotation_audio_mismatch'); }
      else if (spec.endpoint?.kind === 'turn' && spec.endpoint.speechEndMs + spec.endpoint.maxLatencyMs > result.durationMs) {
        result.status = 'blocked'; result.issues.push('insufficient_labeled_audio');
      }
      if (!spec.endpoint) result.issues.push('endpoint_annotation_missing');
      if (!physicalChineseEvidence) result.issues.push('physical_chinese_evidence_missing');
      item.file = file;
    } catch (error) {
      result.status = 'blocked'; result.issues.push(error instanceof Error && error.message === 'audio_path_outside_corpus' ? 'audio_path_outside_corpus' : 'audio_missing_or_invalid');
    }
  }
  return { corpus, manifestSha256: sha256(manifestBytes), recordings };
}
export interface TurnReplayClock {
  now(): number;
  waitUntil(atMs: number, signal: AbortSignal): Promise<void>;
}
const realClock: TurnReplayClock = {
  now: () => performance.now(),
  async waitUntil(atMs, signal) { await delay(Math.max(0, atMs - performance.now()), undefined, { signal }); }
};
export interface EndpointReplayObservation {
  endpoint: { reason: SpeechEndpointReason; atMs: number; processedAudioMs: number } | null;
  readyMs: number;
  replayMs: number;
  deliveredAudioMs: number;
  maxFrameDelayMs: number;
  finalReceived: boolean;
  emptyTranscript: boolean;
}
/** Bounded, paced file replay. Startup is excluded, inference is included. A
 * stop drains samples captured up to the endpoint's wall-clock position, as the
 * renderer does; already-buffered speech must not be discarded by the harness. */
export async function replayEndpointClip(options: {
  provider: SpeechAsrProvider; pcm: Uint8Array; signal: AbortSignal; clock?: TurnReplayClock;
}): Promise<EndpointReplayObservation> {
  const { provider, pcm, signal } = options, clock = options.clock ?? realClock;
  if (!pcm.byteLength || pcm.byteLength % 2 || pcm.byteLength > 60 * 32_000) throw new Error('invalid_audio');
  const requestId = randomUUID(), started = clock.now();
  let audioStarted: number | undefined, readyMs: number | undefined, inputEnded = false, deliveredBytes = 0, maxFrameDelayMs = 0;
  let endpoint: EndpointReplayObservation['endpoint'] = null, finalReceived = false, emptyTranscript = false;
  let revision = 0;
  const cancelled = () => { if (signal.aborted) throw new SpeechProviderError('cancelled', 'Turn evaluation cancelled.'); };
  const stopByte = () => endpoint ? Math.min(pcm.length, Math.floor(endpoint.atMs * 16) * 2) : pcm.length;
  async function* frames(): AsyncIterable<Uint8Array> {
    if (audioStarted === undefined) throw new Error('input_before_ready');
    while (deliveredBytes < stopByte()) {
      cancelled();
      const scheduledEnd = Math.min(deliveredBytes + FRAME_BYTES, stopByte());
      await clock.waitUntil(audioStarted + scheduledEnd / 32, signal);
      cancelled();
      const end = Math.min(scheduledEnd, stopByte());
      if (end <= deliveredBytes) break;
      maxFrameDelayMs = Math.max(maxFrameDelayMs, clock.now() - audioStarted - scheduledEnd / 32);
      const frame = pcm.subarray(deliveredBytes, end); deliveredBytes = end;
      yield frame;
    }
    inputEnded = true;
  }
  try {
    for await (const event of provider.recognize({ requestId, format: { codec: 'pcm16le', sampleRate: 16000, channels: 1 }, audio: frames(), signal })) {
      cancelled();
      if (event.requestId !== requestId || finalReceived) throw new Error('invalid_replay_event_order');
      if (event.type === 'ready') {
        if (readyMs !== undefined) throw new Error('duplicate_replay_ready');
        readyMs = clock.now() - started; audioStarted = clock.now();
      } else {
        if (audioStarted === undefined || readyMs === undefined) throw new Error('replay_event_before_ready');
        if (event.type === 'endpoint') {
          if (endpoint || inputEnded) throw new Error('invalid_replay_endpoint');
          endpoint = { reason: event.reason, atMs: clock.now() - audioStarted, processedAudioMs: deliveredBytes / 32 };
        } else if (event.type === 'partial') {
          if (!Number.isSafeInteger(event.revision) || event.revision <= revision) throw new Error('invalid_replay_revision');
          revision = event.revision;
        } else {
          if (!inputEnded) throw new Error('replay_final_before_eof');
          finalReceived = true;
        }
      }
    }
  } catch (error) {
    // Noise clips may intentionally produce no transcript. This is valid only
    // after EOF; model/process/protocol failures never become a missed endpoint.
    if (error instanceof SpeechProviderError && error.code === 'empty_result' && inputEnded && readyMs !== undefined) emptyTranscript = true;
    else throw error;
  }
  cancelled();
  if (readyMs === undefined || audioStarted === undefined || !inputEnded || !finalReceived && !emptyTranscript) throw new Error('incomplete_endpoint_replay');
  return { endpoint, readyMs, replayMs: clock.now() - audioStarted, deliveredAudioMs: deliveredBytes / 32, maxFrameDelayMs, finalReceived, emptyTranscript };
}
export async function evaluatePreparedTurnCorpus(prepared: PreparedTurnCorpus, options: {
  provider: SpeechAsrProvider; signal: AbortSignal; clock?: TurnReplayClock;
}) {
  const results: (PreparedRecording['result'] & { observation?: EndpointReplayObservation })[] = [];
  for (const item of prepared.recordings) {
    if (options.signal.aborted) throw new SpeechProviderError('cancelled', 'Turn evaluation cancelled.');
    const result: (typeof results)[number] = { ...item.result, issues: [...item.result.issues] }; results.push(result);
    if (result.status !== 'ready' || !item.file) continue;
    try {
      const bytes = await boundedRead(item.file, MAX_WAV_BYTES);
      if (sha256(bytes) !== result.audioSha256) throw new Error('fixture_changed');
      result.observation = await replayEndpointClip({ ...options, pcm: parseStreamingPcmFixture(bytes) });
      result.score = scoreEndpoint(item.spec.endpoint, result.durationMs!, result.observation.endpoint?.atMs ?? null);
      result.status = 'measured';
    } catch (error) {
      if (options.signal.aborted) throw error;
      result.status = 'error'; result.issues.push(error instanceof SpeechProviderError ? error.code : 'replay_failed');
    }
  }
  return { cases: results, ...summarizeEndpointCorpus(prepared.corpus, results) };
}
async function modelFingerprint(file: string) {
  const digest = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(file)) { digest.update(chunk); bytes += (chunk as Buffer).byteLength; }
  return { sha256: digest.digest('hex'), bytes };
}
async function main(): Promise<void> {
  const args = process.argv.slice(2); if (args[0] === '--') args.shift();
  const { values } = parseArgs({ args, allowPositionals: false, options: {
    check: { type: 'boolean' }, run: { type: 'boolean' }, manifest: { type: 'string' }, report: { type: 'string' }, python: { type: 'string' }, vad: { type: 'string' },
    paraformer: { type: 'string' }, 'smart-turn': { type: 'string' }, 'fallback-timeout-ms': { type: 'string', default: '3000' }, help: { type: 'boolean', short: 'h' }
  } });
  if (values.help) { process.stdout.write(HELP); return; }
  const fallbackTimeoutMs = Number(values['fallback-timeout-ms']);
  if (values.check && values.run || !Number.isSafeInteger(fallbackTimeoutMs) || fallbackTimeoutMs < 500 || fallbackTimeoutMs > 10000
    || [values.manifest, values.report, values.python, values.vad, values.paraformer, values['smart-turn']].some(value => value !== undefined && (!value.trim() || value.includes('\0')))) throw new Error('invalid_evaluation_arguments');
  const manifestFile = path.resolve(values.manifest ?? path.join(ROOT, 'tests/fixtures/speech/manifest.json'));
  const prepared = await prepareTurnCorpus(manifestFile);
  const base = { version: 1, createdAt: new Date().toISOString(), manifestSha256: prepared.manifestSha256,
    mode: values.run ? 'paced_model_replay' : 'check', frameMs: 200, sampleRate: 16000, fallbackTimeoutMs,
    microphoneOpened: false, playbackStarted: false, transcriptsIncluded: false };
  const report = async (value: unknown) => {
    const json = `${JSON.stringify(value, null, 2)}\n`;
    if (values.report) {
      const target = path.resolve(values.report);
      if (target === manifestFile || prepared.recordings.some(item => item.file === target)) throw new Error('report_would_overwrite_corpus');
      // Do not follow a destination symlink into a source WAV or the manifest.
      const handle = await open(target, 'wx', 0o600);
      try { await handle.writeFile(json); } finally { await handle.close(); }
    }
    process.stdout.write(json);
  };
  if (!values.run || !prepared.recordings.some(item => item.result.status === 'ready')) {
    const cases = prepared.recordings.map(item => item.result);
    await report({ ...base, cases, ...summarizeEndpointCorpus(prepared.corpus, cases) }); process.exitCode = 2; return;
  }
  const pythonPath = values.python ?? path.join(ROOT, '.local-speech/venv/bin/python3');
  const vadModel = path.resolve(values.vad ?? path.join(ROOT, '.local-speech/models/silero_vad.onnx'));
  const paraformerDirectory = path.resolve(values.paraformer ?? path.join(ROOT, '.local-speech/models/StreamingParaformer'));
  const smartTurnModel = path.resolve(values['smart-turn'] ?? path.join(ROOT, '.local-speech/models/smart-turn-v3.1.onnx'));
  const modelFiles = { vad: vadModel, encoder: path.join(paraformerDirectory, 'encoder.int8.onnx'), decoder: path.join(paraformerDirectory, 'decoder.int8.onnx'),
    tokens: path.join(paraformerDirectory, 'tokens.txt'), smartTurn: smartTurnModel };
  const models = Object.fromEntries(await Promise.all(Object.entries(modelFiles).map(async ([name, file]) => [name, await modelFingerprint(file)])));
  const provider = new StreamingSpeechAsr({ autoEndpoint: true, fallbackTimeoutMs, createClient: () => createSpeechSidecarHost({
    pythonPath, scriptPath: path.join(ROOT, 'apps/desktop/src/worker/speech-sidecar/main.py'), vadModel, paraformerDirectory, smartTurnModel
  }) });
  const controller = new AbortController(), cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const result = await evaluatePreparedTurnCorpus(prepared, { provider, signal: controller.signal });
    await report({ ...base, models, ...result });
    process.exitCode = result.cases.some(item => item.status === 'error') || result.assessment.status === 'thresholds_failed' ? 1 : result.assessment.status === 'criteria_met' ? 0 : 2;
  } finally { controller.abort(); await provider.dispose(); process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => { process.stderr.write('Local turn evaluation failed. Check --help, the corpus labels and local model availability.\n'); process.exitCode = 1; });
}
