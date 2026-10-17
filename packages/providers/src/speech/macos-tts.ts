import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SPEECH_LIMITS, SpeechProviderError, type SpeechTtsProvider, type TtsEvent } from '@desktop-agent/contracts';

const SAY_EXECUTABLE = '/usr/bin/say';
const MAX_VOICE_LIST_BYTES = 256 * 1024;

export interface MacosTtsVoice { name: string; locale: string }
export interface MacosTtsOptions {
  /** Injectable only for offline process-lifecycle tests. */
  spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  platform?: NodeJS.Platform;
  temporaryDirectory?: string;
  timeoutMs?: number;
  maxAudioBytes?: number;
  maxTextChars?: number;
}

interface SayRequest {
  input?: string;
  outputPath?: string;
  maxAudioBytes?: number;
}

/** Runs only Apple's local synthesizer; text is never placed in argv or played directly. */
export function createMacosTtsProvider(options: MacosTtsOptions = {}): SpeechTtsProvider {
  validateOptions(options);
  return { async *synthesize(input): AsyncIterable<TtsEvent> {
    const details = { requestId: input.requestId };
    assertMacos(options);
    throwIfCancelled(input.signal, input.requestId);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(input.requestId)) {
      throw new SpeechProviderError('protocol_error', 'TTS attempt requires a UUID request ID.', details);
    }
    if (!input.text.trim()) throw new SpeechProviderError('empty_result', 'There is no readable text to synthesize.', details);
    if (Array.from(input.text).length > (options.maxTextChars ?? SPEECH_LIMITS.autoReadChars)) {
      throw new SpeechProviderError('protocol_error', 'TTS text exceeds the configured limit.', details);
    }
    if (!input.speakerId.trim() || input.speakerId.length > 256 || containsControlCharacters(input.speakerId)) {
      throw new SpeechProviderError('speaker_unavailable', 'Choose an installed macOS voice.', details);
    }
    if (!Number.isInteger(input.speechRate) || input.speechRate < -50 || input.speechRate > 100) {
      throw new SpeechProviderError('protocol_error', 'TTS speech rate is outside the supported range.', details);
    }

    const controller = new AbortController();
    const cancelled = () => controller.abort(new SpeechProviderError('cancelled', 'TTS request was cancelled.', details));
    input.signal.addEventListener('abort', cancelled, { once: true });
    const deadline = setTimeout(() => controller.abort(new SpeechProviderError('timeout', 'Local speech synthesis timed out.', details)), options.timeoutMs ?? 30_000);
    let directory: string | undefined;
    try {
      const voices = await readVoices(options, controller.signal);
      const selected = input.speakerId === 'default'
        ? voices.find(voice => voice.name === 'Tingting' && voice.locale === 'zh_CN')
          ?? voices.find(voice => voice.locale === 'zh_CN')
          ?? voices.find(voice => voice.locale.startsWith('zh_'))
        : voices.find(voice => voice.name === input.speakerId);
      if (!selected) throw new SpeechProviderError('speaker_unavailable', 'The selected macOS voice is unavailable. Install a Chinese voice in System Settings or choose an installed voice.', details);
      throwIfAborted(controller.signal);
      directory = await mkdtemp(join(options.temporaryDirectory ?? tmpdir(), 'jojo-tts-'));
      await chmod(directory, 0o700);
      const outputPath = join(directory, 'speech.wav');
      const handle = await open(outputPath, 'wx', 0o600);
      await handle.close();
      throwIfAborted(controller.signal);
      await runSay(options, [
        '-v', selected.name, '-r', String(Math.round(180 * (1 + input.speechRate / 100))),
        '-o', outputPath, '--file-format=WAVE', '--data-format=LEI16@24000', '--channels=1', '-f', '-'
      ], controller.signal, { input: input.text, outputPath, maxAudioBytes: options.maxAudioBytes ?? SPEECH_LIMITS.ttsBytes });
      const bytes = await readWav(outputPath, options.maxAudioBytes ?? SPEECH_LIMITS.ttsBytes);
      throwIfAborted(controller.signal);
      validateWav(bytes);
      // The process has closed before these bytes enter the shared playback/cache pipeline.
      await rm(directory, { recursive: true, force: true });
      directory = undefined;
      throwIfAborted(controller.signal);
      clearTimeout(deadline);
      yield { type: 'audio', requestId: input.requestId, bytes, format: 'wav', sampleRate: 24000 };
      throwIfCancelled(input.signal, input.requestId);
      yield { type: 'completed', requestId: input.requestId };
    } catch (error) {
      const controlled = controller.signal.aborted ? controller.signal.reason : error;
      if (controlled instanceof SpeechProviderError) throw new SpeechProviderError(controlled.code, controlled.message, details);
      throw new SpeechProviderError('local_unavailable', 'macOS speech synthesis could not complete. Check that a local voice is installed.', details);
    } finally {
      clearTimeout(deadline);
      input.signal.removeEventListener('abort', cancelled);
      if (directory) await removeTemporaryDirectory(directory, input.requestId);
    }
  } };
}

/** `say -v ?` lists installed voices without synthesizing or downloading audio. */
export async function listMacosTtsVoices(options: MacosTtsOptions = {}, signal = new AbortController().signal): Promise<MacosTtsVoice[]> {
  validateOptions(options);
  assertMacos(options);
  throwIfCancelled(signal);
  const controller = new AbortController();
  const cancelled = () => controller.abort(new SpeechProviderError('cancelled', 'Voice discovery was cancelled.'));
  signal.addEventListener('abort', cancelled, { once: true });
  const deadline = setTimeout(() => controller.abort(new SpeechProviderError('timeout', 'Local voice discovery timed out.')), options.timeoutMs ?? 30_000);
  try { return await readVoices(options, controller.signal); }
  finally { clearTimeout(deadline); signal.removeEventListener('abort', cancelled); }
}

async function readVoices(options: MacosTtsOptions, signal: AbortSignal): Promise<MacosTtsVoice[]> {
  const output = await runSay(options, ['-v', '?'], signal, {});
  const voices: MacosTtsVoice[] = [];
  for (const line of output.toString('utf8').split(/\r?\n/u)) {
    const match = /^(.+?)\s+([a-z]{2,3}_[A-Z0-9]{2,3})\s+#/u.exec(line);
    if (!match) continue;
    const name = match[1]!.trim();
    if (name.length && name.length <= 256 && !containsControlCharacters(name)) voices.push({ name, locale: match[2]! });
  }
  return voices;
}

function runSay(options: MacosTtsOptions, args: readonly string[], signal: AbortSignal, request: SayRequest): Promise<Buffer> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try { child = (options.spawn ?? nodeSpawn)(SAY_EXECUTABLE, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch { reject(new SpeechProviderError('local_unavailable', 'The macOS speech command is unavailable.')); return; }
    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stopped = false;
    let failure: SpeechProviderError | undefined;
    let killDeadline: ReturnType<typeof setTimeout> | undefined;
    let sizeCheck: ReturnType<typeof setInterval> | undefined;
    const cleanup = () => {
      stopped = true;
      signal.removeEventListener('abort', abort);
      if (sizeCheck) clearInterval(sizeCheck);
      if (killDeadline) clearTimeout(killDeadline);
    };
    const finish = (error?: SpeechProviderError) => {
      if (stopped) return;
      cleanup();
      if (error) reject(error); else resolve(Buffer.concat(chunks));
    };
    const stop = (error: SpeechProviderError) => {
      if (stopped || failure) return;
      failure = error;
      child.stdin?.destroy();
      // Cancellation must stop synthesis before its private output directory is removed.
      killDeadline = setTimeout(() => finish(error), 250);
      try { child.kill('SIGKILL'); } catch { /* Keep command failures private. */ }
    };
    const abort = () => stop(signal.reason instanceof SpeechProviderError ? signal.reason : new SpeechProviderError('cancelled', 'TTS request was cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
    child.on('error', () => stop(new SpeechProviderError('local_unavailable', 'The macOS speech command could not start.')));
    child.on('close', (code: number | null) => finish(failure ?? (code === 0 ? undefined : new SpeechProviderError('local_unavailable', 'The installed macOS voice could not synthesize audio.'))));
    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (stopped || failure) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += bytes.length;
      if (stdoutBytes > MAX_VOICE_LIST_BYTES) stop(new SpeechProviderError('protocol_error', 'Local speech command output exceeds its limit.'));
      else chunks.push(bytes);
    });
    child.stdin?.on('error', () => stop(new SpeechProviderError('local_unavailable', 'The macOS speech command could not accept text.')));
    if (request.outputPath) sizeCheck = setInterval(() => {
      void stat(request.outputPath!).then(info => {
        if (info.size > request.maxAudioBytes!) stop(new SpeechProviderError('invalid_audio', 'Local speech audio exceeds its byte limit.'));
      }, () => undefined);
    }, 25);
    if (signal.aborted) abort();
    else child.stdin?.end(request.input ?? '', 'utf8');
  });
}

async function readWav(path: string, maxBytes: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 44 || info.size > maxBytes) throw new SpeechProviderError('invalid_audio', 'Local speech audio is empty or exceeds its byte limit.');
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) throw new SpeechProviderError('invalid_audio', 'Local speech audio is incomplete.');
      offset += result.bytesRead;
    }
    return bytes;
  } finally { await file.close(); }
}

function validateWav(bytes: Buffer): void {
  const invalid = () => new SpeechProviderError('invalid_audio', 'Local speech output must be complete mono 24 kHz PCM16 WAV audio.');
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.readUInt32LE(4) !== bytes.length - 8 || bytes.toString('ascii', 8, 12) !== 'WAVE') throw invalid();
  let offset = 12;
  let format = false;
  let audio = false;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw invalid();
    const kind = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end > bytes.length) throw invalid();
    if (kind === 'fmt ') {
      if (format || length < 16 || bytes.readUInt16LE(start) !== 1 || bytes.readUInt16LE(start + 2) !== 1 || bytes.readUInt32LE(start + 4) !== 24000
        || bytes.readUInt32LE(start + 8) !== 48000 || bytes.readUInt16LE(start + 12) !== 2 || bytes.readUInt16LE(start + 14) !== 16) throw invalid();
      format = true;
    }
    if (kind === 'data') { if (audio || !length || length % 2) throw invalid(); audio = true; }
    offset = end + (length % 2);
  }
  if (!format || !audio || offset !== bytes.length) throw invalid();
}

function assertMacos(options: MacosTtsOptions): void {
  if ((options.platform ?? process.platform) !== 'darwin') throw new SpeechProviderError('local_unavailable', 'System voice synthesis is available on macOS only.');
}
function throwIfCancelled(signal: AbortSignal, requestId?: string): void {
  if (signal.aborted) throw new SpeechProviderError('cancelled', 'TTS request was cancelled.', requestId ? { requestId } : {});
}
function throwIfAborted(signal: AbortSignal): void { if (signal.aborted) throw signal.reason; }
function containsControlCharacters(value: string): boolean {
  return Array.from(value).some(character => character.codePointAt(0)! < 32 || character.codePointAt(0) === 127);
}
async function removeTemporaryDirectory(directory: string, requestId: string): Promise<void> {
  try { await rm(directory, { recursive: true, force: true }); }
  catch { throw new SpeechProviderError('local_unavailable', 'Local speech temporary audio could not be removed.', { requestId }); }
}
function validateOptions(options: MacosTtsOptions): void {
  for (const value of [options.timeoutMs ?? 30_000, options.maxAudioBytes ?? SPEECH_LIMITS.ttsBytes, options.maxTextChars ?? SPEECH_LIMITS.autoReadChars]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Local TTS limits must be positive integers.');
  }
  if ((options.maxAudioBytes ?? SPEECH_LIMITS.ttsBytes) > SPEECH_LIMITS.ttsBytes) throw new Error('Local TTS audio limit exceeds the shared speech limit.');
}
