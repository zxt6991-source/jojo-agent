import {
  PcmInputFormatSchema, SPEECH_LIMITS, SpeechProviderError, type AsrEvent, type SpeechAsrProvider, type SpeechErrorCode, type SpeechEndpointReason
} from '@desktop-agent/contracts';
import {
  sameVoiceCapture, TurnController, type SidecarCapabilities, type SidecarEvent, type VoiceCaptureContext
} from '@desktop-agent/speech';

/** Host injection keeps process creation and model paths out of the provider. */
export interface SpeechSidecarInputClient {
  start(): Promise<SidecarCapabilities>;
  open(context: VoiceCaptureContext): Promise<void>;
  sendAudio(context: VoiceCaptureContext, sequence: number, pcm: Uint8Array): Promise<void>;
  finish(context: VoiceCaptureContext): Promise<void>;
  close(context: VoiceCaptureContext): Promise<void>;
  subscribe(listener: (event: SidecarEvent) => void): () => void;
  onFailure(listener: (error: Error) => void): () => void;
  dispose(): Promise<void>;
}
export interface StreamingSpeechAsrOptions {
  createClient(): SpeechSidecarInputClient;
  /** Numeric VAD/turn observations can drive a separately verified endpoint controller. */
  onEvent?(event: SidecarEvent): void;
  finalTimeoutMs?: number;
  closeTimeoutMs?: number;
  /** Explicit experiment; model availability never enables this by itself. */
  autoEndpoint?: boolean;
  fallbackTimeoutMs?: number;
}

/** One warm local model process across manually ended captures. Partials are
 * captions only; the existing voice draft/commit flow receives one online final.
 * There is no second recognizer or implicit model download in this adapter. */
export class StreamingSpeechAsr implements SpeechAsrProvider {
  private client: SpeechSidecarInputClient | undefined;
  private readonly voiceSessionId = crypto.randomUUID();
  private generation = 0;
  private active: { cancel(): void } | undefined;
  private disposed = false;
  private readonly finalTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  constructor(private readonly options: StreamingSpeechAsrOptions) {
    this.finalTimeoutMs = options.finalTimeoutMs ?? 30_000;
    this.closeTimeoutMs = options.closeTimeoutMs ?? 2_000;
    if (![this.finalTimeoutMs, this.closeTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0)) {
      throw new RangeError('Streaming ASR limits must be positive integers.');
    }
  }
  private getClient(): SpeechSidecarInputClient {
    if (this.disposed) throw new SpeechProviderError('cancelled', 'Local streaming speech is closed.');
    return this.client ??= this.options.createClient();
  }
  /** Called only by an explicit validation operation; construction stays offline. */
  async probe(): Promise<SidecarCapabilities> {
    try { return await this.getClient().start(); }
    catch (error) {
      if (error instanceof SpeechProviderError) throw error;
      throw new SpeechProviderError('local_unavailable', 'Local streaming speech dependencies or models are unavailable.');
    }
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.active?.cancel();
    const client = this.client; this.client = undefined;
    await client?.dispose();
  }

  async *recognize(input: Parameters<SpeechAsrProvider['recognize']>[0]): AsyncIterable<AsrEvent> {
    const error = (code: SpeechErrorCode, message: string) => new SpeechProviderError(code, message, { requestId: input.requestId });
    if (this.disposed || input.signal.aborted) throw error('cancelled', 'Local streaming speech capture cancelled.');
    if (this.active) throw error('resource_denied', 'Another local streaming speech capture is active.');
    if (!input.requestId.trim() || input.requestId.length > 256 || /[\r\n]/u.test(input.requestId)) throw error('protocol_error', 'Invalid speech request identity.');
    if (!PcmInputFormatSchema.safeParse(input.format).success) throw error('invalid_audio', 'Streaming speech requires 16 kHz mono PCM16LE audio.');
    const client = this.getClient();
    const context: VoiceCaptureContext = { voiceSessionId: this.voiceSessionId, captureId: input.requestId, turnId: input.requestId, generation: ++this.generation };
    let ended = false, opened = false, finishedInput = false, finishing = false, pumpFinished = false;
    let terminal: SpeechProviderError | undefined;
    let partial: string | undefined, lastPartial: string | undefined, final: string | undefined;
    let endpointReason: SpeechEndpointReason | undefined;
    const endpoint = new TurnController({ context, experimentalAutoEndpoint: this.options.autoEndpoint === true,
      ...(this.options.fallbackTimeoutMs === undefined ? {} : { fallbackTimeoutMs: this.options.fallbackTimeoutMs }),
      onEndpoint: reason => {
        if (opened && !finishing && !ended && !terminal && (reason === 'smart_turn' || reason === 'silence_timeout')) {
          endpointReason = reason; notify();
        }
      } });
    let revision = 0, totalBytes = 0;
    let wake: (() => void) | undefined;
    let resolveStop!: () => void;
    const stopped = new Promise<void>(resolve => { resolveStop = resolve; });
    let finalTimer: ReturnType<typeof setTimeout> | undefined;
    let audioIterator: AsyncIterator<Uint8Array> | undefined;
    let audioReturned = false;
    const notify = () => { const callback = wake; wake = undefined; callback?.(); };
    const returnAudio = () => {
      if (audioReturned || finishedInput || !audioIterator) return;
      audioReturned = true;
      try { void Promise.resolve(audioIterator.return?.()).catch(() => undefined); } catch { /* Never wait for an abandoned microphone source. */ }
    };
    const fail = (failure: SpeechProviderError) => {
      if (ended || terminal) return;
      terminal = failure; partial = undefined;
      resolveStop(); notify(); returnAudio();
    };
    const task = { cancel: () => fail(error('cancelled', 'Local streaming speech capture cancelled.')) };
    this.active = task;
    const raceStop = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, stopped.then(() => {
      throw terminal ?? error('cancelled', 'Local streaming speech capture cancelled.');
    })]);
    const onAbort = () => task.cancel();
    input.signal.addEventListener('abort', onAbort, { once: true });
    const unsubscribeFailure = client.onFailure(() => fail(error(opened ? 'protocol_error' : 'local_unavailable',
      opened ? 'Local streaming speech process disconnected.' : 'Local streaming speech dependencies or models are unavailable.')));
    const unsubscribe = client.subscribe(event => {
      if (ended || terminal || event.type === 'ready') return;
      if (event.type === 'error') {
        if (event.voiceSessionId !== undefined && !sameVoiceCapture(event as VoiceCaptureContext, context)) return;
        fail(error(event.code === 'local_unavailable' ? 'local_unavailable' : 'protocol_error', 'Local streaming speech could not process this capture.'));
        return;
      }
      if (!sameVoiceCapture(event, context)) return;
      try { this.options.onEvent?.(event); } catch { /* Observations never decide a user turn. */ }
      if (!finishing) {
        if (event.type === 'vad.started') endpoint.onVadStarted();
        else if (event.type === 'vad.stopped') endpoint.onVadStopped();
        else if (event.type === 'turn.complete') endpoint.onSmartTurnComplete();
        else if (event.type === 'turn.incomplete') endpoint.onSmartTurnIncomplete();
      }
      if (event.type === 'asr.partial') {
        if (!opened || finishing || event.text.length > 20_000) {
          fail(error('protocol_error', 'Invalid local streaming transcript order.')); return;
        }
        // Coalesce producer bursts into one bounded caption, preserving no history.
        if (event.text !== lastPartial) { partial = event.text; lastPartial = event.text; notify(); }
      } else if (event.type === 'asr.final') {
        if (!finishing || final !== undefined || event.text.length > 20_000) {
          fail(error('protocol_error', 'Invalid local streaming final result.')); return;
        }
        if (!event.text.trim()) { fail(error('empty_result', 'Local streaming speech returned no recognized words.')); return; }
        final = event.text.trim();
        if (pumpFinished && finalTimer) clearTimeout(finalTimer);
        notify();
      } else if (event.type === 'audio.gap' && event.turnReset) {
        fail(error('invalid_audio', 'Local streaming speech lost audio; record the sentence again.'));
      }
    });
    let pump: Promise<void> | undefined;
    try {
      const caps = await raceStop(client.start());
      if (!caps.vad.available || !caps.streamingAsr.available) throw error('local_unavailable', 'Local Silero VAD or Streaming Paraformer models are unavailable.');
      if (this.options.autoEndpoint && !caps.smartTurn.available) throw error('local_unavailable', 'Automatic endpoint requires a working local Smart Turn model and runtime.');
      await raceStop(client.open(context));
      opened = true;
      endpoint.start();
      if (terminal) throw terminal;
      yield { type: 'ready', requestId: input.requestId };
      pump = (async () => {
        try {
          audioIterator = input.audio[Symbol.asyncIterator]();
          let sequence = 0;
          while (!terminal && !ended) {
            const item = await raceStop(Promise.resolve(audioIterator.next()));
            if (item.done) { finishedInput = true; break; }
            const bytes = item.value;
            if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength % 2 || bytes.byteLength > SPEECH_LIMITS.maxChunkBytes ||
              totalBytes + bytes.byteLength > SPEECH_LIMITS.captureBytes) throw error('invalid_audio', 'Local streaming speech audio exceeded its bounds.');
            totalBytes += bytes.byteLength;
            // One sidecar ACK in flight. Upstream requests its next frame only
            // after this ACK, which also releases the renderer's capture credit.
            for (let offset = 0; offset < bytes.byteLength; offset += 32_000) {
              await raceStop(client.sendAudio(context, sequence++, bytes.slice(offset, offset + 32_000)));
            }
          }
          if (terminal || ended) return;
          if (!totalBytes) throw error('invalid_audio', 'Local streaming speech capture is empty.');
          finishing = true;
          endpoint.stop(); endpointReason = undefined;
          finalTimer = setTimeout(() => fail(error('timeout', 'Local streaming speech final result timed out.')), this.finalTimeoutMs);
          await raceStop(client.finish(context));
          pumpFinished = true;
          if (final !== undefined && finalTimer) clearTimeout(finalTimer);
          notify();
        } catch (failure) {
          fail(failure instanceof SpeechProviderError ? failure : error('protocol_error', 'Local streaming speech could not process this capture.'));
        }
      })();
      while (true) {
        if (terminal) throw terminal;
        if (endpointReason !== undefined) {
          const reason = endpointReason; endpointReason = undefined;
          yield { type: 'endpoint', requestId: input.requestId, reason };
          continue;
        }
        if (partial !== undefined) {
          const text = partial; partial = undefined;
          yield { type: 'partial', requestId: input.requestId, revision: ++revision, text };
          continue;
        }
        if (final !== undefined && pumpFinished) {
          yield { type: 'final', requestId: input.requestId, text: final, durationMs: totalBytes / 32 };
          return;
        }
        await new Promise<void>(resolve => { wake = resolve; });
      }
    } catch (failure) {
      if (failure instanceof SpeechProviderError) throw failure;
      throw error(opened ? 'protocol_error' : 'local_unavailable', opened
        ? 'Local streaming speech could not process this capture.' : 'Local streaming speech dependencies or models are unavailable.');
    } finally {
      ended = true; resolveStop(); notify(); returnAudio();
      endpoint.stop();
      if (finalTimer) clearTimeout(finalTimer);
      input.signal.removeEventListener('abort', onAbort);
      unsubscribe(); unsubscribeFailure();
      await pump;
      // open() may have been cancelled after the process accepted it. Always
      // close this identity; a missing context is a no-op in the real client.
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([client.close(context), new Promise<never>((_, reject) => {
          closeTimer = setTimeout(() => reject(new Error('close_timeout')), this.closeTimeoutMs);
        })]);
      } catch {
        // Ambiguous close cannot leave a stale capture in a reusable process.
        if (this.client === client) this.client = undefined;
        await client.dispose().catch(() => undefined);
      } finally { if (closeTimer) clearTimeout(closeTimer); }
      if (this.active === task) this.active = undefined;
    }
  }
}

export function createStreamingSpeechAsr(options: StreamingSpeechAsrOptions): StreamingSpeechAsr {
  return new StreamingSpeechAsr(options);
}

