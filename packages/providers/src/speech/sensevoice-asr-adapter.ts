import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import type { Readable, Writable } from 'node:stream';

import { PcmInputFormatSchema, SPEECH_LIMITS, SpeechProviderError } from '@desktop-agent/contracts';
import type { AsrEvent, SpeechAsrProvider, SpeechErrorCode } from '@desktop-agent/contracts';

import { SENSEVOICE_PYTHON_HELPER } from './sensevoice-python-helper.js';

export interface SenseVoiceProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  on(event: 'error' | 'close', listener: (...args: any[]) => void): unknown;
  off(event: 'error' | 'close', listener: (...args: any[]) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}
export type SenseVoiceSpawn = (executable: string, args: string[], options: {
  stdio: ['pipe', 'pipe', 'ignore']; shell: false; windowsHide: true; env: NodeJS.ProcessEnv;
}) => SenseVoiceProcess;
export interface SenseVoiceAsrOptions {
  pythonPath: string;
  modelDirectory: string;
  language?: 'auto' | 'zh' | 'en' | 'ja' | 'ko' | 'yue';
  spawn?: SenseVoiceSpawn;
  loadTimeoutMs?: number;
  finalTimeoutMs?: number;
  writeTimeoutMs?: number;
}

const LANGUAGES = new Set(['auto', 'zh', 'en', 'ja', 'ko', 'yue']);
const MAX_CAPTURE_BYTES = Math.min(SPEECH_LIMITS.captureBytes, SPEECH_LIMITS.captureMs * 32);

function helperEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  // The helper has no use for credentials or application-specific environment variables.
  for (const key of ['PATH', 'HOME', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL']) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}

export class SenseVoiceAsrAdapter implements SpeechAsrProvider {
  private readonly active = new Set<() => void>();
  private disposed = false;
  private readonly loadTimeoutMs: number;
  private readonly finalTimeoutMs: number;
  private readonly writeTimeoutMs: number;

  constructor(private readonly options: SenseVoiceAsrOptions) {
    this.loadTimeoutMs = options.loadTimeoutMs ?? 30_000;
    this.finalTimeoutMs = options.finalTimeoutMs ?? 30_000;
    this.writeTimeoutMs = options.writeTimeoutMs ?? 2_000;
    if (![this.loadTimeoutMs, this.finalTimeoutMs, this.writeTimeoutMs]
      .every(value => Number.isSafeInteger(value) && value > 0)) throw new RangeError('ASR limits must be positive integers.');
  }

  dispose(): void {
    this.disposed = true;
    for (const cancel of this.active) cancel();
    this.active.clear();
  }

  async *recognize(input: Parameters<SpeechAsrProvider['recognize']>[0]): AsyncIterable<AsrEvent> {
    const { requestId, signal } = input;
    const error = (code: SpeechErrorCode, message: string): SpeechProviderError =>
      new SpeechProviderError(code, message, { requestId });
    if (this.disposed || signal.aborted) throw error('cancelled', 'Local ASR recognition cancelled.');
    if (!requestId.trim() || requestId.length > 256 || /[\r\n]/u.test(requestId)) {
      throw error('protocol_error', 'Invalid ASR request identity.');
    }
    if (!PcmInputFormatSchema.safeParse(input.format).success) {
      throw error('invalid_audio', 'ASR requires 16 kHz mono PCM16LE audio.');
    }
    const { pythonPath, modelDirectory } = this.options;
    const language = this.options.language ?? 'auto';
    if (!pythonPath?.trim() || pythonPath.length > 4096 || pythonPath.includes('\0') ||
      !modelDirectory || modelDirectory.length > 4096 || modelDirectory.includes('\0') || !isAbsolute(modelDirectory) || !LANGUAGES.has(language)) {
      throw error('local_unavailable', 'Choose a Python executable and an absolute local SenseVoice model directory.');
    }

    let child: SenseVoiceProcess;
    try {
      child = (this.options.spawn ?? spawn)(pythonPath,
        ['-I', '-u', '-c', SENSEVOICE_PYTHON_HELPER, modelDirectory, language],
        { stdio: ['pipe', 'pipe', 'ignore'], shell: false, windowsHide: true, env: helperEnvironment() });
    } catch { throw error('local_unavailable', 'Could not start the local SenseVoice Python process.'); }

    let terminalError: SpeechProviderError | undefined;
    let closed = false;
    let stopped = false;
    let ready = false;
    let tailSubmitted = false;
    let finalText: string | undefined;
    let stdoutBytes = 0;
    let pending = Buffer.alloc(0);
    let totalBytes = 0;
    let audioIterator: AsyncIterator<Uint8Array> | undefined;
    let iteratorCompleted = false;
    let iteratorReturnRequested = false;
    let resolveReady!: () => void;
    const readyPromise = new Promise<void>(resolve => { resolveReady = resolve; });
    let resolveClosed!: () => void;
    const closedPromise = new Promise<void>(resolve => { resolveClosed = resolve; });
    let resolveStopped!: () => void;
    const stoppedPromise = new Promise<void>(resolve => { resolveStopped = resolve; });
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const timer = (callback: () => void, ms: number): ReturnType<typeof setTimeout> => {
      const handle = setTimeout(() => { timers.delete(handle); callback(); }, ms);
      timers.add(handle); return handle;
    };
    const clearTimer = (handle: ReturnType<typeof setTimeout>): void => { clearTimeout(handle); timers.delete(handle); };
    const closeAudio = (): void => {
      if (!audioIterator || iteratorCompleted || iteratorReturnRequested) return;
      iteratorReturnRequested = true;
      try { void Promise.resolve(audioIterator.return?.()).catch(() => {}); } catch { /* Cancellation cannot wait on upstream. */ }
    };
    const stop = (): void => {
      if (stopped) return;
      stopped = true; resolveStopped();
      for (const handle of timers) clearTimeout(handle);
      timers.clear(); closeAudio();
      try { child.stdin.destroy(); } catch { /* Continue to terminate inference. */ }
      if (!closed) try { child.kill('SIGKILL'); } catch { /* Already exited. */ }
    };
    const fail = (failure: SpeechProviderError): void => {
      if (stopped) return;
      terminalError = failure; stop();
    };
    const cancel = (): void => fail(error('cancelled', 'Local ASR recognition cancelled.'));
    const checkRunning = (): void => {
      if (stopped) throw terminalError ?? error('cancelled', 'Local ASR recognition ended.');
    };
    const raceStop = <T>(operation: Promise<T>): Promise<T> => {
      checkRunning();
      return Promise.race([operation, stoppedPromise.then(() => {
        throw terminalError ?? error('cancelled', 'Local ASR recognition ended.');
      })]);
    };
    const outputFailure = (): void => fail(error('protocol_error', 'Local ASR returned an invalid response.'));
    const onData = (chunk: unknown): void => {
      if (stopped) return;
      try {
        if (!(chunk instanceof Uint8Array)) { outputFailure(); return; }
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > SPEECH_LIMITS.asrMessageBytes) { outputFailure(); return; }
        pending = Buffer.concat([pending, chunk]);
        while (pending.includes(10)) {
          const newline = pending.indexOf(10);
          const line = new TextDecoder('utf-8', { fatal: true }).decode(pending.subarray(0, newline));
          pending = pending.subarray(newline + 1);
          const message: unknown = JSON.parse(line);
          if (!message || typeof message !== 'object' || Array.isArray(message)) { outputFailure(); return; }
          const value = message as Record<string, unknown>;
          if (value.type === 'ready' && Object.keys(value).length === 1 && !ready) {
            ready = true; resolveReady();
          } else if (value.type === 'final' && Object.keys(value).length === 2 && typeof value.text === 'string' &&
            ready && tailSubmitted && finalText === undefined) {
            finalText = value.text;
          } else if (value.type === 'error' && Object.keys(value).length === 2 &&
            ['local_unavailable', 'invalid_audio', 'protocol_error'].includes(value.code as string)) {
            const code = value.code as 'local_unavailable' | 'invalid_audio' | 'protocol_error';
            fail(error(code, code === 'local_unavailable'
              ? 'Local SenseVoice dependencies or model files are unavailable.' : 'Local ASR could not process this audio.'));
          } else { outputFailure(); return; }
        }
      } catch { outputFailure(); }
    };
    const onError = (): void => fail(error('local_unavailable', 'Could not run the local SenseVoice Python process.'));
    const onClose = (code: number | null): void => {
      closed = true;
      if (stopped) return;
      if (code !== 0) { onError(); return; }
      if (!ready) { fail(error('local_unavailable', 'Local SenseVoice did not become ready.')); return; }
      if (pending.byteLength || finalText === undefined || !tailSubmitted) { outputFailure(); return; }
      resolveClosed();
    };
    child.on('error', onError); child.on('close', onClose);
    child.stdin.on('error', onError);
    child.stdout.on('error', outputFailure); child.stdout.on('data', onData);
    this.active.add(cancel);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();

    try {
      const loadTimeout = timer(() => fail(error('timeout', 'Local ASR model loading timed out.')), this.loadTimeoutMs);
      await raceStop(readyPromise);
      clearTimer(loadTimeout);
      const captureTimeout = timer(() => fail(error('timeout', 'ASR audio capture exceeded its time limit.')), SPEECH_LIMITS.captureMs);
      yield { type: 'ready', requestId };
      checkRunning();
      try { audioIterator = input.audio[Symbol.asyncIterator](); }
      catch { throw error('invalid_audio', 'Local ASR audio input failed.'); }
      while (true) {
        let item: IteratorResult<Uint8Array>;
        try { item = await raceStop(Promise.resolve(audioIterator.next())); }
        catch (failure) { throw failure instanceof SpeechProviderError ? failure : error('invalid_audio', 'Local ASR audio input failed.'); }
        if (item.done) { iteratorCompleted = true; break; }
        const pcm = item.value;
        if (!(pcm instanceof Uint8Array) || !pcm.byteLength || pcm.byteLength % 2 ||
          pcm.byteLength > SPEECH_LIMITS.maxChunkBytes || totalBytes + pcm.byteLength > MAX_CAPTURE_BYTES) {
          throw error('invalid_audio', 'Invalid or oversized ASR PCM input.');
        }
        totalBytes += pcm.byteLength;
        let writeTimeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await raceStop(new Promise<void>((resolve, reject) => {
            writeTimeout = timer(() => fail(error('timeout', 'Local ASR audio input stalled.')), this.writeTimeoutMs);
            child.stdin.write(Buffer.from(pcm), failure => {
              if (failure) reject(error('local_unavailable', 'Could not send audio to the local ASR process.'));
              else resolve();
            });
          }));
        } catch (failure) {
          throw failure instanceof SpeechProviderError ? failure : error('local_unavailable', 'Could not send audio to the local ASR process.');
        } finally { if (writeTimeout !== undefined) clearTimer(writeTimeout); }
      }
      if (!totalBytes) throw error('invalid_audio', 'ASR requires non-empty audio input.');
      clearTimer(captureTimeout);
      tailSubmitted = true;
      const finalTimeout = timer(() => fail(error('timeout', 'Local ASR final result timed out.')), this.finalTimeoutMs);
      try { child.stdin.end(); }
      catch { throw error('local_unavailable', 'Could not finish audio input to the local ASR process.'); }
      await raceStop(closedPromise);
      clearTimer(finalTimeout);
      checkRunning();
      if (!finalText?.trim()) throw error('empty_result', 'Local ASR returned no recognized speech.');
      yield { type: 'final', requestId, text: finalText, durationMs: totalBytes / 32 };
    } finally {
      stop(); this.active.delete(cancel); signal.removeEventListener('abort', cancel);
      child.stdout.off('data', onData); child.stdout.off('error', outputFailure);
      child.stdin.off('error', onError); child.off('error', onError); child.off('close', onClose);
      // A failed spawn or a destroyed pipe can deliver an error after cancellation.
      const ignore = (): void => {};
      const removeShutdownListeners = (): void => {
        child.stdin.off('error', ignore); child.stdout.off('error', ignore);
        child.off('error', ignore); child.off('close', removeShutdownListeners);
      };
      if (!closed) {
        child.stdin.on('error', ignore); child.stdout.on('error', ignore);
        child.on('error', ignore); child.on('close', removeShutdownListeners);
      }
    }
  }
}

export function createSenseVoiceAsrProvider(options: SenseVoiceAsrOptions): SenseVoiceAsrAdapter {
  return new SenseVoiceAsrAdapter(options);
}
