import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { LOCAL_NEURAL_VOICES, SPEECH_LIMITS, SpeechProviderError, type SpeechErrorCode, type SpeechTtsProvider, type TtsEvent } from '@desktop-agent/contracts';
import { encodeSidecarFrame, SidecarFrameDecoder } from '@desktop-agent/speech';

export interface TtsCandidateObservation { type: 'started' | 'native_callback' | 'native_pcm' | 'completed'; requestId: string; atMs?: number; samples?: number }
export interface SherpaTtsCandidateOptions {
  pythonPath: string; scriptPath: string; modelDirectory: string; threads?: number; timeoutMs?: number;
  /** Melo/CosyVoice remain CLI candidates; MLX Qwen is explicitly selectable in Desktop. */
  engine?: 'sherpa' | 'cosyvoice3' | 'mlx-qwen3'; sourceDirectory?: string; referenceWav?: string;
  /** CLI resource sampling only. No raw library diagnostics are retained. */
  onProcess?(child: ChildProcessWithoutNullStreams): void;
  onObservation?(event: TtsCandidateObservation): void;
  spawn?: typeof spawn;
}
export interface TtsCandidateReady { nativeSampleRate: number; runtimeVersion: string; loadMs: number }
interface ProcessState {
  child: ChildProcessWithoutNullStreams; ready: Promise<TtsCandidateReady>; closed: Promise<void>;
  resolveReady(value: TtsCandidateReady): void; rejectReady(error: Error): void;
  readyValue?: TtsCandidateReady; decoder: SidecarFrameDecoder; terminated: boolean;
}
interface Attempt {
  id: string; process: ProcessState; chunks: Uint8Array[]; bytes: number; sequence: number; callbacks: number; started: boolean;
  done: Promise<void>; resolve(): void; reject(error: Error): void; terminal: boolean;
}
const failure = (code: SpeechErrorCode) => new SpeechProviderError(code, 'Local TTS candidate could not complete this utterance.');

/** Local complete-WAV stdio process shared by explicit candidate evaluation and Desktop. Model
 * process is reused; cancel awaits its exit and the next utterance loads anew.
 * Sentence callbacks are diagnostics, never advertised as native audio output. */
export class LocalTtsCandidateProcess implements SpeechTtsProvider {
  private process: ProcessState | undefined;
  private active: Attempt | undefined;
  private disposed = false;
  private processCount = 0;
  constructor(private readonly options: SherpaTtsCandidateOptions) {
    if (![options.pythonPath, options.scriptPath, options.modelDirectory].every(value => value.trim() && !value.includes('\0'))
      || !path.isAbsolute(options.scriptPath) || !path.isAbsolute(options.modelDirectory)
      || !Number.isSafeInteger(options.threads ?? 2) || (options.threads ?? 2) < 1 || (options.threads ?? 2) > 8
      || !Number.isSafeInteger(options.timeoutMs ?? 30_000) || (options.timeoutMs ?? 30_000) < 1
      || (options.engine !== undefined && !['sherpa', 'cosyvoice3', 'mlx-qwen3'].includes(options.engine))
      || (options.engine === 'cosyvoice3' && ![options.sourceDirectory, options.referenceWav].every(value => value && !value.includes('\0') && path.isAbsolute(value)))) throw failure('protocol_error');
  }
  get processesStarted(): number { return this.processCount; }
  async probe(): Promise<TtsCandidateReady> { return this.ensureProcess().ready; }
  private ensureProcess(): ProcessState {
    if (this.disposed) throw failure('cancelled');
    if (this.process && !this.process.terminated) return this.process;
    const env: NodeJS.ProcessEnv = { PYTHONDONTWRITEBYTECODE: '1', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', USE_TORCH: this.options.engine === 'cosyvoice3' ? '1' : '0', USE_TF: '0' };
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SystemRoot']) if (process.env[key]) env[key] = process.env[key];
    const child = (this.options.spawn ?? spawn)(this.options.pythonPath, ['-B', '-u', this.options.scriptPath, '--model-dir', this.options.modelDirectory, '--threads', String(this.options.threads ?? 2),
      ...(this.options.engine === 'cosyvoice3' ? ['--source-dir', this.options.sourceDirectory!, '--reference-wav', this.options.referenceWav!] : [])],
      { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, env }) as ChildProcessWithoutNullStreams;
    this.processCount++;
    let resolveReady!: ProcessState['resolveReady'], rejectReady!: ProcessState['rejectReady'];
    const ready = new Promise<TtsCandidateReady>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    void ready.catch(() => undefined);
    let resolveClosed!: () => void;
    const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
    const state: ProcessState = { child, ready, closed, resolveReady, rejectReady, decoder: new SidecarFrameDecoder(), terminated: false };
    this.process = state;
    const timer = setTimeout(() => { this.failProcess(state, failure('timeout')); }, this.options.timeoutMs ?? 30_000);
    void ready.then(() => clearTimeout(timer), () => clearTimeout(timer));
    child.stderr.resume(); child.stdin.on('error', () => this.failProcess(state, failure('protocol_error')));
    child.stdout.on('data', (bytes: Buffer) => {
      if (state.terminated) return;
      try { for (const frame of state.decoder.push(bytes)) this.receive(state, frame.header, frame.body); }
      catch { this.failProcess(state, failure('protocol_error')); }
    });
    child.once('error', () => { this.failProcess(state, failure('local_unavailable')); resolveClosed(); });
    child.once('close', () => {
      try { state.decoder.finish(); } catch { this.failProcess(state, failure('protocol_error')); }
      if (!state.terminated) this.failProcess(state, failure('local_unavailable'));
      resolveClosed();
    });
    try { this.options.onProcess?.(child); } catch { /* Resource observations cannot alter synthesis. */ }
    return state;
  }
  private receive(state: ProcessState, header: Record<string, unknown>, body: Uint8Array): void {
    if (header.type === 'tts.error') {
      const code = ['local_unavailable', 'synthesis_failed', 'synthesis_limit', 'invalid_audio', 'empty_result'].includes(String(header.code)) ? header.code as SpeechErrorCode : 'protocol_error';
      this.failProcess(state, failure(code)); return;
    }
    if (header.type === 'tts.ready') {
      if (state.readyValue || body.length || header.protocolVersion !== 1 || !Number.isSafeInteger(header.sampleRate)
        || (header.sampleRate as number) < 8000 || (header.sampleRate as number) > 96000
        || (this.options.engine !== 'sherpa' && this.options.engine !== undefined && header.sampleRate !== 24000) || typeof header.runtimeVersion !== 'string'
        || !/^[0-9.]{1,32}$/u.test(header.runtimeVersion) || typeof header.loadMs !== 'number' || !Number.isFinite(header.loadMs) || header.loadMs < 0) throw failure('protocol_error');
      state.readyValue = { nativeSampleRate: header.sampleRate as number, runtimeVersion: header.runtimeVersion, loadMs: header.loadMs };
      state.resolveReady(state.readyValue); return;
    }
    const task = this.active;
    if (!state.readyValue || !task || task.process !== state || header.requestId !== task.id || task.terminal) throw failure('protocol_error');
    if (header.type === 'tts.started') {
      if (task.started || body.length) throw failure('protocol_error');
      task.started = true; this.observe({ type: 'started', requestId: task.id }); return;
    }
    if (!task.started) throw failure('protocol_error');
    if (header.type === 'tts.callback') {
      if (body.length || header.callback !== ++task.callbacks || task.callbacks > 1000 || !Number.isSafeInteger(header.samples) || (header.samples as number) <= 0
        || typeof header.atMs !== 'number' || !Number.isFinite(header.atMs) || header.atMs < 0) throw failure('protocol_error');
      this.observe({ type: 'native_callback', requestId: task.id, atMs: header.atMs, samples: header.samples as number }); return;
    }
    if (header.type === 'tts.pcm') {
      if (header.sequence !== ++task.sequence || header.sampleRate !== 24000 || !body.length || body.length % 2 || body.length > 65536
        || task.bytes + body.length > SPEECH_LIMITS.ttsBytes - 44) throw failure('protocol_error');
      task.chunks.push(body); task.bytes += body.length;
      this.observe({ type: 'native_pcm', requestId: task.id, samples: body.length / 2 }); return;
    }
    if (header.type !== 'tts.completed' || body.length || !task.bytes || header.frames !== task.bytes / 2) throw failure('protocol_error');
    task.terminal = true; this.observe({ type: 'completed', requestId: task.id }); task.resolve();
  }
  private observe(event: TtsCandidateObservation): void { try { this.options.onObservation?.(event); } catch { /* No diagnostic affects synthesis. */ } }
  private failProcess(state: ProcessState, error: Error): void {
    state.rejectReady(error);
    if (this.active?.process === state) { this.active.terminal = true; this.active.reject(error); }
    void this.terminate(state);
  }
  private async terminate(state: ProcessState): Promise<void> {
    if (!state.terminated) {
      state.terminated = true;
      if (this.process === state) this.process = undefined;
      state.child.stdin.destroy(); state.child.stdout.destroy(); state.child.stderr.destroy();
      state.child.kill('SIGTERM');
      const force = setTimeout(() => state.child.kill('SIGKILL'), 1000); force.unref();
      void state.closed.then(() => clearTimeout(force));
    }
    await state.closed;
  }
  async *synthesize(input: Parameters<SpeechTtsProvider['synthesize']>[0]): AsyncIterable<TtsEvent> {
    if (this.disposed || input.signal.aborted) throw failure('cancelled');
    if (this.active) throw failure('resource_denied');
    if (!input.requestId || input.requestId.length > 256 || !input.text.trim() || input.text.includes('\0') || Array.from(input.text).length > SPEECH_LIMITS.autoReadChars
      || !(this.options.engine === 'mlx-qwen3' ? ['default', ...LOCAL_NEURAL_VOICES] : ['default', '0']).includes(input.speakerId)
      || !Number.isInteger(input.speechRate) || input.speechRate < -50 || input.speechRate > 100
      || ((this.options.engine === 'cosyvoice3' || this.options.engine === 'mlx-qwen3') && input.speechRate !== 0)) throw failure('protocol_error');
    const state = this.ensureProcess();
    let resolve!: () => void, reject!: (error: Error) => void;
    const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); void done.catch(() => undefined);
    const task: Attempt = { id: input.requestId, process: state, chunks: [], bytes: 0, sequence: 0, callbacks: 0, started: false, terminal: false, done, resolve, reject };
    this.active = task;
    const abort = () => this.failProcess(state, failure('cancelled'));
    input.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => this.failProcess(state, failure('timeout')), this.options.timeoutMs ?? 30_000);
    try {
      if (input.signal.aborted) abort();
      await Promise.race([state.ready, done]);
      if (input.signal.aborted || state.terminated) throw failure('cancelled');
      const frame = encodeSidecarFrame({ type: 'tts.synthesize', requestId: input.requestId, text: input.text, speed: 1 + input.speechRate / 100,
        ...(this.options.engine === 'mlx-qwen3' ? { speakerId: input.speakerId } : {}) });
      await Promise.race([done, new Promise<void>((yes, no) => state.child.stdin.write(frame, error => error ? no(failure('protocol_error')) : yes()))]);
      await done;
      clearTimeout(timer);
      if (input.signal.aborted) throw failure('cancelled');
      const wav = pcmWav24k(task.chunks, task.bytes);
      task.chunks.length = 0;
      yield { type: 'audio', requestId: input.requestId, format: 'wav', sampleRate: 24000, bytes: wav };
      if (input.signal.aborted) throw failure('cancelled');
      yield { type: 'completed', requestId: input.requestId };
    } catch (error) {
      await this.terminate(state);
      throw input.signal.aborted ? failure('cancelled') : error instanceof SpeechProviderError ? error : failure('local_unavailable');
    } finally {
      clearTimeout(timer); input.signal.removeEventListener('abort', abort); task.chunks.length = 0;
      if (!task.terminal && !state.terminated) await this.terminate(state);
      if (this.active === task) this.active = undefined;
    }
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const state = this.process ?? this.active?.process;
    if (state) { this.failProcess(state, failure('cancelled')); await this.terminate(state); }
  }
}
/** Compatibility name for the original Melo-only candidate. */
export { LocalTtsCandidateProcess as SherpaTtsCandidate };
function pcmWav24k(chunks: readonly Uint8Array[], bytes: number): Uint8Array {
  const wav = Buffer.alloc(44 + bytes);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8); wav.write('fmt ', 12); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(bytes, 40);
  let offset = 44; for (const chunk of chunks) { wav.set(chunk, offset); offset += chunk.length; }
  return wav;
}
