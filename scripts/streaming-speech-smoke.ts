import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { SpeechProviderError, type SpeechAsrProvider, type SpeechEndpointReason } from '@desktop-agent/contracts';
import { createSpeechSidecarHost } from '../apps/desktop/src/worker/speech-sidecar-host';
import { StreamingSpeechAsr } from '../apps/desktop/src/worker/streaming-input';

const REPOSITORY = fileURLToPath(new URL('../', import.meta.url));
const MAX_PCM_BYTES = 60 * 32_000;
const MAX_WAV_BYTES = MAX_PCM_BYTES + 64 * 1024;
const FRAME_BYTES = 6_400;
const HELP = `Local persistent Streaming Paraformer smoke test. No playback, downloads or settings changes.

Run from the repository:
  pnpm --filter @desktop-agent/desktop exec tsx ../../scripts/streaming-speech-smoke.ts \\
    --wav /absolute/path/to/16k-mono-pcm16.wav \\
    --python /absolute/path/to/python \\
    --vad /absolute/path/to/silero_vad.onnx \\
    --paraformer /absolute/path/to/StreamingParaformer

Options:
  --wav PATH             Required: complete 16 kHz mono PCM16LE RIFF/WAVE, at most 60 seconds.
  --python PATH          Default: <repository>/.local-speech/venv/bin/python3
  --vad PATH             Default: <repository>/.local-speech/models/silero_vad.onnx
  --paraformer PATH      Default: <repository>/.local-speech/models/StreamingParaformer
  --iterations NUMBER    1..5, default 2. One provider/process is reused across captures.
  --expected-text TEXT   Optional expected transcript. Reports normalized-match boolean only.
                        Comparison uses NFKC, lowercase and removes whitespace/punctuation.
  --show-text            Explicitly include final transcripts in stdout; default is private.
  --smart-turn PATH      Optional local Smart Turn ONNX model.
  --auto-endpoint        Exercise automatic stopping with the local Smart Turn model.
                        Appends up to 2 s of silence, then waits for endpoint/timeout.
  --fallback-timeout-ms  Experimental silence fallback, 500..10000, default 3000.
  --help, -h             Show help without opening audio or loading models.

PCM is replayed in sequential 200 ms frames, as fast as the sidecar acknowledges
them. Timings describe an unpaced local fixture replay, not live microphone TTFA.
The default JSON output contains metadata, numeric timings and booleans only;
it never includes paths, expected text, partial captions, audio or final text.
No recording, transcript or report file is written by this script.
`;

function invalidWav(): SpeechProviderError {
  return new SpeechProviderError('invalid_audio', 'Provide complete 16 kHz mono PCM16LE WAV audio of at most 60 seconds.');
}
function fourcc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}
/** Bounded RIFF parser, exported for offline fixture verification. Unknown
 * metadata chunks are skipped, including their required odd-length padding. */
export function parseStreamingPcmFixture(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength < 46 || bytes.byteLength > MAX_WAV_BYTES) throw invalidWav();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (fourcc(bytes, 0) !== 'RIFF' || fourcc(bytes, 8) !== 'WAVE' || view.getUint32(4, true) !== bytes.byteLength - 8) throw invalidWav();
  let offset = 12, formatted = false;
  let pcm: Uint8Array | undefined;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) throw invalidWav();
    const kind = fourcc(bytes, offset), length = view.getUint32(offset + 4, true), start = offset + 8;
    const end = start + length, paddedEnd = end + length % 2;
    if (paddedEnd > bytes.byteLength) throw invalidWav();
    if (kind === 'fmt ') {
      if (formatted || pcm || length < 16 || view.getUint16(start, true) !== 1 || view.getUint16(start + 2, true) !== 1
        || view.getUint32(start + 4, true) !== 16_000 || view.getUint32(start + 8, true) !== 32_000
        || view.getUint16(start + 12, true) !== 2 || view.getUint16(start + 14, true) !== 16) throw invalidWav();
      formatted = true;
    } else if (kind === 'data') {
      if (!formatted || pcm || !length || length % 2 || length > MAX_PCM_BYTES) throw invalidWav();
      pcm = bytes.subarray(start, end);
    }
    offset = paddedEnd;
  }
  if (offset !== bytes.byteLength || !formatted || !pcm) throw invalidWav();
  return pcm;
}
export async function readStreamingPcmFixture(file: string): Promise<Uint8Array> {
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 46 || info.size > MAX_WAV_BYTES) throw invalidWav();
    const bytes = new Uint8Array(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) throw invalidWav();
      offset += result.bytesRead;
    }
    if ((await handle.stat()).size !== bytes.byteLength) throw invalidWav();
    return parseStreamingPcmFixture(bytes);
  } finally { await handle.close(); }
}
export function normalizeExpectedStreamingText(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[\p{P}\p{Z}\s]/gu, '');
}
export interface StreamingSmokeRun {
  round: number;
  firstCapture: boolean;
  frames: number;
  readyMs: number;
  firstPartialMs: number | null;
  finalMs: number;
  finalAfterInputEndMs: number;
  totalMs: number;
  partialCount: number;
  recognizedChars: number;
  expectedTextMatches?: boolean;
  finalText?: string;
  endpointReason?: SpeechEndpointReason;
  endpointMs?: number;
}
export interface StreamingSmokeOptions {
  provider: SpeechAsrProvider;
  pcm: Uint8Array;
  signal: AbortSignal;
  iterations?: number;
  expectedText?: string;
  showText?: boolean;
  autoEndpoint?: boolean;
  endpointTimeoutMs?: number;
  /** Tests can supply a monotonic deterministic clock. */
  now?(): number;
}
export async function runStreamingSpeechSmoke(options: StreamingSmokeOptions): Promise<StreamingSmokeRun[]> {
  const { pcm, signal } = options, iterations = options.iterations ?? 2, now = options.now ?? (() => performance.now());
  if (!pcm.byteLength || pcm.byteLength % 2 || pcm.byteLength > MAX_PCM_BYTES) throw invalidWav();
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 5) throw new SpeechProviderError('protocol_error', 'Choose between one and five smoke iterations.');
  const cancelled = () => { if (signal.aborted) throw new SpeechProviderError('cancelled', 'Local streaming speech smoke cancelled.'); };
  const runs: StreamingSmokeRun[] = [];
  for (let round = 1; round <= iterations; round++) {
    cancelled();
    const requestId = randomUUID(), startedAt = now();
    let readyMs: number | undefined, firstPartialMs: number | null = null, finalMs: number | undefined;
    let frames = 0, partialCount = 0, previousRevision = 0;
    let inputEndedAt: number | undefined, finalText: string | undefined;
    let endpointReason: SpeechEndpointReason | undefined, endpointMs: number | undefined;
    let resolveEndpoint!: () => void;
    const endpoint = new Promise<void>(resolve => { resolveEndpoint = resolve; });
    async function* framesForCapture(): AsyncIterable<Uint8Array> {
      for (let offset = 0; offset < pcm.byteLength; offset += FRAME_BYTES) {
        if (options.autoEndpoint && endpointReason) break;
        cancelled(); frames++;
        yield pcm.subarray(offset, offset + FRAME_BYTES);
      }
      if (options.autoEndpoint) {
        const silenceBytes = Math.min(10 * FRAME_BYTES, MAX_PCM_BYTES - pcm.byteLength);
        for (let offset = 0; offset < silenceBytes && !endpointReason; offset += FRAME_BYTES) {
          cancelled(); frames++; yield new Uint8Array(Math.min(FRAME_BYTES, silenceBytes - offset));
        }
        if (!endpointReason) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const abort = () => resolveEndpoint(); signal.addEventListener('abort', abort, { once: true });
          try {
            cancelled();
            await Promise.race([endpoint, new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new SpeechProviderError('timeout', 'No automatic endpoint was received.')), options.endpointTimeoutMs ?? 15_000);
            })]);
            cancelled();
          } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
        }
      }
      inputEndedAt = now();
    }
    for await (const event of options.provider.recognize({ requestId, format: { codec: 'pcm16le', sampleRate: 16000, channels: 1 }, audio: framesForCapture(), signal })) {
      cancelled();
      if (event.requestId !== requestId || finalText !== undefined) throw new SpeechProviderError('protocol_error', 'Unexpected local streaming speech event order.');
      if (event.type === 'ready') {
        if (readyMs !== undefined) throw new SpeechProviderError('protocol_error', 'Duplicate local streaming speech readiness.');
        readyMs = now() - startedAt;
      } else if (event.type === 'partial') {
        if (readyMs === undefined || event.revision <= previousRevision || !Number.isSafeInteger(event.revision)) throw new SpeechProviderError('protocol_error', 'Invalid local streaming caption order.');
        previousRevision = event.revision; partialCount++;
        firstPartialMs ??= now() - startedAt;
      } else if (event.type === 'endpoint') {
        if (!options.autoEndpoint || readyMs === undefined || endpointReason) throw new SpeechProviderError('protocol_error', 'Unexpected or repeated automatic endpoint.');
        endpointReason = event.reason; endpointMs = now() - startedAt; resolveEndpoint();
      } else {
        if (readyMs === undefined || inputEndedAt === undefined || !event.text.trim()) throw new SpeechProviderError('protocol_error', 'Local streaming speech finalized before complete fixture input.');
        finalText = event.text.trim(); finalMs = now() - startedAt;
      }
    }
    cancelled();
    if (finalText === undefined || readyMs === undefined || finalMs === undefined || inputEndedAt === undefined) throw new SpeechProviderError('empty_result', 'Local streaming speech ended without a final result.');
    runs.push({ round, firstCapture: round === 1, frames, readyMs, firstPartialMs, finalMs,
      finalAfterInputEndMs: Math.max(0, startedAt + finalMs - inputEndedAt), totalMs: now() - startedAt,
      partialCount, recognizedChars: Array.from(finalText).length,
      ...(endpointReason === undefined ? {} : { endpointReason, endpointMs: endpointMs! }),
      ...(options.expectedText === undefined ? {} : { expectedTextMatches: normalizeExpectedStreamingText(finalText) === normalizeExpectedStreamingText(options.expectedText) }),
      ...(options.showText ? { finalText } : {}) });
  }
  return runs;
}
function report(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }
async function main(): Promise<void> {
  const argv = process.argv.slice(2); if (argv[0] === '--') argv.shift();
  const { values } = parseArgs({ args: argv, allowPositionals: false, options: {
    wav: { type: 'string' }, python: { type: 'string' }, vad: { type: 'string' }, paraformer: { type: 'string' },
    iterations: { type: 'string', default: '2' }, 'expected-text': { type: 'string' }, 'show-text': { type: 'boolean' },
    'smart-turn': { type: 'string' }, 'auto-endpoint': { type: 'boolean' }, 'fallback-timeout-ms': { type: 'string', default: '3000' },
    help: { type: 'boolean', short: 'h' }
  } });
  if (values.help) { process.stdout.write(HELP); return; }
  const iterations = Number(values.iterations);
  const fallbackTimeoutMs = Number(values['fallback-timeout-ms']);
  if (!values.wav?.trim() || !Number.isSafeInteger(iterations) || iterations < 1 || iterations > 5
    || !Number.isSafeInteger(fallbackTimeoutMs) || fallbackTimeoutMs < 500 || fallbackTimeoutMs > 10000
    || [values.wav, values.python, values.vad, values.paraformer, values['smart-turn']].some(value => value !== undefined && (!value.trim() || value.includes('\0')))
    || values['expected-text'] !== undefined && (!values['expected-text'].trim() || values['expected-text'].length > 20_000)) {
    throw new SpeechProviderError('protocol_error', 'Run with --help and provide a valid WAV fixture and local model paths.');
  }
  const pcm = await readStreamingPcmFixture(path.resolve(values.wav));
  const turnDecisions: { type: string; score?: number; inferenceMs?: number }[] = [];
  const provider = new StreamingSpeechAsr({ autoEndpoint: values['auto-endpoint'] ?? false, fallbackTimeoutMs,
    onEvent: event => { if (turnDecisions.length < 64 && (event.type === 'turn.complete' || event.type === 'turn.incomplete')) turnDecisions.push({ type: event.type, score: event.score, inferenceMs: event.inferenceMs }); },
    createClient: () => createSpeechSidecarHost({
    pythonPath: values.python ?? path.join(REPOSITORY, '.local-speech', 'venv', 'bin', 'python3'),
    scriptPath: path.join(REPOSITORY, 'apps', 'desktop', 'src', 'worker', 'speech-sidecar', 'main.py'),
    vadModel: path.resolve(values.vad ?? path.join(REPOSITORY, '.local-speech', 'models', 'silero_vad.onnx')),
    paraformerDirectory: path.resolve(values.paraformer ?? path.join(REPOSITORY, '.local-speech', 'models', 'StreamingParaformer')),
    ...(values['auto-endpoint'] || values['smart-turn'] ? { smartTurnModel: path.resolve(values['smart-turn'] ?? path.join(REPOSITORY, '.local-speech', 'models', 'smart-turn-v3.1.onnx')) } : {})
  }) });
  const controller = new AbortController(), cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const runs = await runStreamingSpeechSmoke({ provider, pcm, signal: controller.signal, iterations, autoEndpoint: values['auto-endpoint'] ?? false,
      ...(values['expected-text'] === undefined ? {} : { expectedText: values['expected-text'] }), showText: values['show-text'] ?? false });
    const matchesExpected = runs.every(run => run.expectedTextMatches !== false);
    report({ completed: true, provider: 'sherpa-onnx-streaming-paraformer', replay: 'unpaced_ack_bounded',
      sampleRate: 16_000, channels: 1, bitsPerSample: 16, frameMs: 200, audioMs: pcm.byteLength / 32,
      iterations, providerInstances: 1, normalizedExpectedTextChecked: values['expected-text'] !== undefined,
      ...(values['expected-text'] === undefined ? {} : { matchesExpected }), autoEndpoint: values['auto-endpoint'] ?? false, turnDecisions, runs });
    if (!matchesExpected) process.exitCode = 1;
  } finally {
    controller.abort(); await provider.dispose();
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    report({ completed: false, code: error instanceof SpeechProviderError ? error.code : 'local_unavailable' });
    process.exitCode = 1;
  });
}
