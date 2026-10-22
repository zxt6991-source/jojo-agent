import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { LOCAL_NEURAL_VOICES, SPEECH_LIMITS, SpeechProviderError, type SpeechErrorCode, type SpeechTtsProvider, type SpeechTtsInput, type TtsEvent, type TtsPcmEvent } from '@desktop-agent/contracts';
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
export interface TtsCandidateReady { nativeSampleRate: number; runtimeVersion: string; loadMs: number; cooperativeCancel?: true }
interface ProcessState {
  child: ChildProcessWithoutNullStreams; ready: Promise<TtsCandidateReady>; closed: Promise<void>;
  resolveReady(value: TtsCandidateReady): void; rejectReady(error: Error): void;
  readyValue?: TtsCandidateReady; decoder: SidecarFrameDecoder; terminated: boolean; reading?: boolean; warmed?: boolean;
}
interface Attempt {
  id: string; process: ProcessState; chunks: Uint8Array[]; bytes: number; bufferedBytes: number; sequence: number; callbacks: number; started: boolean;
  done: Promise<void>; resolve(): void; reject(error: Error): void; terminal: boolean;
  error?: Error; changed?: () => void; sent?: boolean; cancelling?: boolean; cancelConfirmed?: boolean; cancellation?: Promise<void>;
}
const failure = (code: SpeechErrorCode) => new SpeechProviderError(code, 'Local TTS candidate could not complete this utterance.');
const PCM_HIGH_WATER_BYTES = 48_000; // One second; a bounded pipe read may add up to two native frames.
const PIPE_READ_BYTES = 65_536;
const CANCEL_GRACE_MS = 750;

/** Local PCM stdio process shared by explicit candidate evaluation and Desktop. Model
 * process is reused after a confirmed cooperative cancel; unsupported or stalled
 * cancellation awaits process exit before the next utterance loads anew.
 * Complete-WAV callers collect the same validated PCM stream for compatibility. */
export class LocalTtsCandidateProcess implements SpeechTtsProvider {
  private process: ProcessState | undefined;
  private active: Attempt | undefined;
  private disposed = false;
  private processCount = 0;
  private warming: Promise<void> | undefined;
  readonly synthesizePcm?: (input: SpeechTtsInput) => AsyncIterable<TtsPcmEvent>;
  constructor(private readonly options: SherpaTtsCandidateOptions) {
    if (![options.pythonPath, options.scriptPath, options.modelDirectory].every(value => value.trim() && !value.includes('\0'))
      || !path.isAbsolute(options.scriptPath) || !path.isAbsolute(options.modelDirectory)
      || !Number.isSafeInteger(options.threads ?? 2) || (options.threads ?? 2) < 1 || (options.threads ?? 2) > 8
      || !Number.isSafeInteger(options.timeoutMs ?? 30_000) || (options.timeoutMs ?? 30_000) < 1
      || (options.engine !== undefined && !['sherpa', 'cosyvoice3', 'mlx-qwen3'].includes(options.engine))
      || (options.engine === 'cosyvoice3' && ![options.sourceDirectory, options.referenceWav].every(value => value && !value.includes('\0') && path.isAbsolute(value)))) throw failure('protocol_error');
    // The other candidates only yield sentence callbacks; they must continue to
    // advertise complete-WAV output even though their private transport is PCM.
    if (options.engine === 'mlx-qwen3') this.synthesizePcm = input => this.streamPcm(input);
  }
  get processesStarted(): number { return this.processCount; }
  async probe(): Promise<TtsCandidateReady> { return this.ensureProcess().ready; }
  async warmup(signal: AbortSignal): Promise<void> {
    if (this.disposed || signal.aborted) throw failure('cancelled');
    if (this.process?.warmed && !this.process.terminated) return;
    return this.warming ??= (async () => {
      for await (const event of this.streamPcm({ requestId: crypto.randomUUID(), text: '你好。', speakerId: 'default', speechRate: 0, signal })) { void event; /* Discard warmup audio. */ }
    })().finally(() => { this.warming = undefined; });
  }
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
    // Read only while the consumer has room. Node's stream and the OS pipe then
    // propagate backpressure to the sidecar's blocking stdout writes.
    child.stdout.on('readable', () => this.readAvailable(state));
    child.once('error', () => { this.failProcess(state, failure('local_unavailable')); resolveClosed(); });
    child.once('close', () => {
      try { state.decoder.finish(); } catch { this.failProcess(state, failure('protocol_error')); }
      if (!state.terminated) this.failProcess(state, failure('local_unavailable'));
      resolveClosed();
    });
    try { this.options.onProcess?.(child); } catch { /* Resource observations cannot alter synthesis. */ }
    return state;
  }
  private readAvailable(state: ProcessState): void {
    if (state.terminated || state.reading) return;
    state.reading = true;
    try {
      while (!state.terminated && (!this.active || this.active.process !== state || this.active.bufferedBytes < PCM_HIGH_WATER_BYTES)) {
        const available = state.child.stdout.readableLength;
        if (!available) break;
        const bytes = state.child.stdout.read(Math.min(available, PIPE_READ_BYTES)) as Buffer | null;
        if (!bytes) break;
        for (const frame of state.decoder.push(bytes)) this.receive(state, frame.header, frame.body);
      }
    } catch { this.failProcess(state, failure('protocol_error')); }
    finally { state.reading = false; }
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
        || (header.cooperativeCancel !== undefined && header.cooperativeCancel !== true)
        || !/^[0-9.]{1,32}$/u.test(header.runtimeVersion) || typeof header.loadMs !== 'number' || !Number.isFinite(header.loadMs) || header.loadMs < 0) throw failure('protocol_error');
      state.readyValue = { nativeSampleRate: header.sampleRate as number, runtimeVersion: header.runtimeVersion, loadMs: header.loadMs,
        ...(this.options.engine === 'mlx-qwen3' && header.cooperativeCancel === true ? { cooperativeCancel: true as const } : {}) };
      state.resolveReady(state.readyValue); return;
    }
    const task = this.active;
    if (!state.readyValue || !task || task.process !== state || header.requestId !== task.id) throw failure('protocol_error');
    if (header.type === 'tts.cancelled') {
      if (body.length || !task.cancelling || task.cancelConfirmed || !state.readyValue.cooperativeCancel) throw failure('protocol_error');
      task.terminal = true; task.cancelConfirmed = true; task.resolve();
      task.changed?.(); delete task.changed; return;
    }
    if (task.terminal) throw failure('protocol_error');
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
      task.bytes += body.length;
      if (!task.cancelling) { task.chunks.push(body); task.bufferedBytes += body.length; }
      task.changed?.(); delete task.changed;
      this.observe({ type: 'native_pcm', requestId: task.id, samples: body.length / 2 }); return;
    }
    if (header.type !== 'tts.completed' || body.length || !task.bytes || header.frames !== task.bytes / 2) throw failure('protocol_error');
    task.terminal = true; state.warmed = true; this.observe({ type: 'completed', requestId: task.id });
    if (!task.cancelling) task.resolve();
    task.changed?.(); delete task.changed;
  }
  private cancelAttempt(task: Attempt): Promise<void> {
    if (task.cancellation) return task.cancellation;
    const state = task.process;
    task.cancelling = true; task.chunks.length = 0; task.bufferedBytes = 0;
    task.changed?.(); delete task.changed;
    task.cancellation = (async () => {
      // Fully validated completion is already a barrier. Cancelling only the
      // downstream buffer must not evict an idle, warm model.
      if (task.terminal && !task.error && !state.terminated) { task.cancelConfirmed = true; return; }
      if (this.disposed || state.terminated || !task.sent || !state.readyValue?.cooperativeCancel) {
        this.failProcess(state, failure('cancelled')); await state.closed; return;
      }
      const deadline = setTimeout(() => this.failProcess(state, failure('cancelled')), CANCEL_GRACE_MS);
      try {
        const frame = encodeSidecarFrame({ type: 'tts.cancel', requestId: task.id });
        state.child.stdin.write(frame, error => { if (error) this.failProcess(state, failure('protocol_error')); });
        // Drain and validate already-written PCM, dropping it rather than
        // leaving the sidecar blocked on stdout before it can read the cancel.
        this.readAvailable(state);
        await task.done.catch(() => undefined);
        if (!task.cancelConfirmed && !state.terminated) this.failProcess(state, failure('protocol_error'));
        if (state.terminated) await state.closed;
      } finally { clearTimeout(deadline); }
    })();
    return task.cancellation;
  }
  private observe(event: TtsCandidateObservation): void { try { this.options.onObservation?.(event); } catch { /* No diagnostic affects synthesis. */ } }
  private failProcess(state: ProcessState, error: Error): void {
    state.rejectReady(error);
    if (this.active?.process === state) {
      this.active.terminal = true; this.active.error = error; this.active.reject(error);
      this.active.changed?.(); delete this.active.changed;
    }
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
  async *synthesize(input: SpeechTtsInput): AsyncIterable<TtsEvent> {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const event of this.streamPcm(input)) {
      if (event.type === 'pcm') { chunks.push(event.bytes); bytes += event.bytes.length; }
    }
    if (input.signal.aborted) throw failure('cancelled');
    yield { type: 'audio', requestId: input.requestId, format: 'wav', sampleRate: 24000, bytes: pcmWav24k(chunks, bytes) };
    if (input.signal.aborted) throw failure('cancelled');
    yield { type: 'completed', requestId: input.requestId };
  }
  private async *streamPcm(input: SpeechTtsInput): AsyncIterable<TtsPcmEvent> {
    if (this.disposed || input.signal.aborted) throw failure('cancelled');
    if (this.active) throw failure('resource_denied');
    if (!input.requestId || input.requestId.length > 256 || !input.text.trim() || input.text.includes('\0') || Array.from(input.text).length > SPEECH_LIMITS.autoReadChars
      || !(this.options.engine === 'mlx-qwen3' ? ['default', ...LOCAL_NEURAL_VOICES] : ['default', '0']).includes(input.speakerId)
      || !Number.isInteger(input.speechRate) || input.speechRate < -50 || input.speechRate > 100
      || ((this.options.engine === 'cosyvoice3' || this.options.engine === 'mlx-qwen3') && input.speechRate !== 0)) throw failure('protocol_error');
    const state = this.ensureProcess();
    let resolve!: () => void, reject!: (error: Error) => void;
    const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); void done.catch(() => undefined);
    const task: Attempt = { id: input.requestId, process: state, chunks: [], bytes: 0, bufferedBytes: 0, sequence: 0, callbacks: 0, started: false, terminal: false, done, resolve, reject };
    this.active = task;
    const abort = () => { void this.cancelAttempt(task); };
    input.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => this.failProcess(state, failure('timeout')), this.options.timeoutMs ?? 30_000);
    let deliveredCompleted = false;
    try {
      if (input.signal.aborted) abort();
      await Promise.race([state.ready, done]);
      if (input.signal.aborted || state.terminated) throw failure('cancelled');
      const frame = encodeSidecarFrame({ type: 'tts.synthesize', requestId: input.requestId, text: input.text, speed: 1 + input.speechRate / 100,
        ...(this.options.engine === 'mlx-qwen3' ? { speakerId: input.speakerId } : {}) });
      task.sent = true;
      await Promise.race([done, new Promise<void>((yes, no) => state.child.stdin.write(frame, error => error ? no(failure('protocol_error')) : yes()))]);
      while (true) {
        if (input.signal.aborted) throw failure('cancelled');
        if (task.error) throw task.error;
        const bytes = task.chunks.shift();
        if (bytes) {
          task.bufferedBytes -= bytes.length;
          this.readAvailable(state);
          if (task.error) throw task.error;
          yield { type: 'pcm', requestId: input.requestId, sampleRate: 24000, bytes };
          continue;
        }
        if (task.terminal) break;
        await new Promise<void>(resolve => { task.changed = resolve; });
      }
      clearTimeout(timer);
      if (input.signal.aborted) throw failure('cancelled');
      deliveredCompleted = true;
      yield { type: 'completed', requestId: input.requestId };
    } catch (error) {
      if (input.signal.aborted) await this.cancelAttempt(task);
      else await this.terminate(state);
      throw input.signal.aborted ? failure('cancelled') : error instanceof SpeechProviderError ? error : failure('local_unavailable');
    } finally {
      clearTimeout(timer); input.signal.removeEventListener('abort', abort); task.chunks.length = 0; task.bufferedBytes = 0;
      if (!deliveredCompleted) await this.cancelAttempt(task);
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
