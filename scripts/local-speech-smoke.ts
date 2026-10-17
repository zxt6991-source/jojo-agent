import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  createLocalSpeechSettings, SPEECH_LIMITS, SpeechProviderError, type SpeechProvider
} from '@desktop-agent/contracts';
import { createSpeechProvider } from '@desktop-agent/providers';

const REPOSITORY = fileURLToPath(new URL('../', import.meta.url));
const MAX_PCM_BYTES = Math.min(SPEECH_LIMITS.captureBytes, SPEECH_LIMITS.captureMs * 32);
const MAX_WAV_BYTES = MAX_PCM_BYTES + 64 * 1024;
const HELP = `Offline local speech smoke test. No playback, cloud requests, downloads or settings changes.

Run from the repository:
  pnpm --filter @desktop-agent/providers exec tsx ../../scripts/local-speech-smoke.ts --tts-only

Test local SenseVoice and macOS system TTS:
  pnpm --filter @desktop-agent/providers exec tsx ../../scripts/local-speech-smoke.ts \\
    --python /absolute/path/to/python \\
    --model-directory /absolute/path/to/SenseVoiceSmall \\
    --wav /absolute/path/to/official-16k-mono-pcm16-fixture.wav

Options:
  --tts-only              Test macOS system TTS only; do not provide --wav.
  --python PATH           Default: <repository>/.local-speech/venv/bin/python3
  --model-directory PATH  Default: <repository>/.local-speech/models/SenseVoiceSmall
  --wav PATH              Required for ASR. Complete 16 kHz mono PCM16LE WAV, at most 60 seconds.
  --help, -h              Show this help without running any speech service.

Use the Python/model paths printed by the local speech installer if different.
TTS uses a fixed nonsensitive Chinese sentence and the installed default Chinese voice.
WAV headers are validated and removed before PCM is sent to ASR.
Only audio metadata, recognition character counts and completion flags are printed.
Synthesized audio is discarded; no audio or transcript is saved by this script.
`;

function report(value: Record<string, unknown>): void { process.stdout.write(`${JSON.stringify(value)}\n`); }
function invalidArguments(): never { throw new SpeechProviderError('protocol_error', 'Run with --help and provide --tts-only or a valid --wav fixture.'); }
function checkCancelled(signal: AbortSignal): void { if (signal.aborted) throw new SpeechProviderError('cancelled', 'Local speech test was cancelled.'); }

/** Accept only bounded, complete, uncompressed RIFF/WAVE PCM; never send its container to ASR. */
async function readPcmFixture(file: string): Promise<Uint8Array> {
  const invalid = () => new SpeechProviderError('invalid_audio', 'Provide complete 16 kHz mono PCM16LE WAV audio of at most 60 seconds.');
  const handle = await open(file, 'r');
  let bytes: Buffer;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 46 || info.size > MAX_WAV_BYTES) throw invalid();
    bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) throw invalid();
      offset += result.bytesRead;
    }
    if ((await handle.stat()).size !== bytes.length) throw invalid();
  } finally { await handle.close(); }
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.readUInt32LE(4) !== bytes.length - 8 || bytes.toString('ascii', 8, 12) !== 'WAVE') throw invalid();
  let offset = 12;
  let format = false;
  let pcm: Uint8Array | undefined;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw invalid();
    const kind = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    const paddedEnd = end + length % 2;
    if (paddedEnd > bytes.length) throw invalid();
    if (kind === 'fmt ') {
      if (format || pcm || length < 16 || bytes.readUInt16LE(start) !== 1 || bytes.readUInt16LE(start + 2) !== 1
        || bytes.readUInt32LE(start + 4) !== 16000 || bytes.readUInt32LE(start + 8) !== 32000
        || bytes.readUInt16LE(start + 12) !== 2 || bytes.readUInt16LE(start + 14) !== 16) throw invalid();
      format = true;
    } else if (kind === 'data') {
      if (!format || pcm || !length || length % 2 || length > MAX_PCM_BYTES) throw invalid();
      pcm = bytes.subarray(start, end);
    }
    offset = paddedEnd;
  }
  if (offset !== bytes.length || !format || !pcm) throw invalid();
  return pcm;
}

async function* pcmChunks(pcm: Uint8Array, signal: AbortSignal): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < pcm.byteLength; offset += SPEECH_LIMITS.pcmChunkBytes) {
    checkCancelled(signal);
    yield pcm.subarray(offset, Math.min(offset + SPEECH_LIMITS.pcmChunkBytes, pcm.byteLength));
  }
}

async function testTts(provider: SpeechProvider, signal: AbortSignal): Promise<void> {
  const requestId = randomUUID();
  let bytes = 0;
  let completed = false;
  for await (const event of provider.tts.synthesize({
    requestId, text: '你好，这是一条离线语音测试。', speakerId: 'default', speechRate: 0, signal
  })) {
    checkCancelled(signal);
    if (event.requestId !== requestId || completed) throw new SpeechProviderError('protocol_error', 'Unexpected local TTS event ordering.');
    if (event.type === 'completed') { completed = true; continue; }
    if (event.format !== 'wav' || event.sampleRate !== 24000 || !event.bytes.byteLength) throw new SpeechProviderError('invalid_audio', 'Local TTS returned an unexpected audio format.');
    bytes += event.bytes.byteLength;
    if (bytes > SPEECH_LIMITS.ttsBytes) throw new SpeechProviderError('invalid_audio', 'Local TTS returned too much audio.');
  }
  checkCancelled(signal);
  if (!completed || !bytes) throw new SpeechProviderError('protocol_error', 'Local TTS ended without complete audio.');
  report({ tts: { format: 'wav', sampleRate: 24000, bytes, completed: true } });
}

async function testAsr(provider: SpeechProvider, pcm: Uint8Array, signal: AbortSignal): Promise<void> {
  const requestId = randomUUID();
  let ready = false;
  let recognizedChars = 0;
  let final = false;
  for await (const event of provider.asr.recognize({
    requestId, format: { codec: 'pcm16le', sampleRate: 16000, channels: 1 }, audio: pcmChunks(pcm, signal), signal
  })) {
    checkCancelled(signal);
    if (event.requestId !== requestId || final) throw new SpeechProviderError('protocol_error', 'Unexpected local ASR event ordering.');
    if (event.type === 'ready') {
      if (ready) throw new SpeechProviderError('protocol_error', 'Local ASR returned a duplicate ready event.');
      ready = true;
    } else if (event.type === 'final') {
      if (!ready || !event.text.trim()) throw new SpeechProviderError('empty_result', 'Local ASR returned no recognized speech.');
      final = true;
      recognizedChars = Array.from(event.text.trim()).length;
    } else if (!ready) throw new SpeechProviderError('protocol_error', 'Local ASR returned text before becoming ready.');
  }
  checkCancelled(signal);
  if (!final) throw new SpeechProviderError('protocol_error', 'Local ASR ended without a final result.');
  report({ asr: { recognizedChars, completed: true } });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === '--') argv.shift();
  let args;
  try {
    args = parseArgs({ args: argv, allowPositionals: false, options: {
      'tts-only': { type: 'boolean' }, python: { type: 'string' },
      'model-directory': { type: 'string' }, wav: { type: 'string' }, help: { type: 'boolean', short: 'h' }
    } });
  } catch { invalidArguments(); }
  if (args.values.help) { process.stdout.write(HELP); return; }
  const ttsOnly = args.values['tts-only'] ?? false;
  const wav = args.values.wav;
  if (ttsOnly ? wav !== undefined : !wav?.trim()) invalidArguments();
  for (const value of [args.values.python, args.values['model-directory'], wav]) {
    if (value !== undefined && (!value.trim() || value.includes('\0'))) invalidArguments();
  }
  const settings = createLocalSpeechSettings();
  settings.provider.asr.local.pythonPath = args.values.python ?? path.join(REPOSITORY, '.local-speech', 'venv', 'bin', 'python3');
  settings.provider.asr.local.modelDirectory = path.resolve(args.values['model-directory'] ?? path.join(REPOSITORY, '.local-speech', 'models', 'SenseVoiceSmall'));
  const pcm = !ttsOnly && wav ? await readPcmFixture(path.resolve(wav)) : undefined;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    // Fixed local provider choices prevent this script from consulting user cloud credentials/configuration.
    const provider = createSpeechProvider(settings);
    await testTts(provider, controller.signal);
    if (pcm) await testAsr(provider, pcm, controller.signal);
    checkCancelled(controller.signal);
    report({ completed: true });
  } finally {
    controller.abort();
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  }
}

void main().catch((error: unknown) => {
  report({ completed: false, code: error instanceof SpeechProviderError ? error.code : 'local_unavailable' });
  process.exitCode = 1;
});
