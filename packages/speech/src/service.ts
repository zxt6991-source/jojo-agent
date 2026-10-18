import {
  AudioAssetOwnerSchema, SpeechSettingsSchema, SPEECH_LIMITS, SPEECH_PROTOCOL_VERSION, SPEECH_TEXT_VERSION,
  SpeechProviderError, type AudioAsset, type AudioAssetOwner, type AsrEvent,
  type SpeechAssetStore, type SpeechProvider, type SpeechSettings, type SpeechMetricEvent
} from '@desktop-agent/contracts';
import { normalizeSpeechText } from './text';

export async function speechCacheKey(text: string, settings: SpeechSettings): Promise<string> {
  const { tts } = settings.provider;
  const key = JSON.stringify([
    text, tts.id, tts.speakerId, tts.speechRate, tts.format, tts.sampleRate,
    ...(tts.id === 'mlx-qwen3' ? [tts.local, 'qwen3-customvoice-4bit-v2-auto-language'] : []),
    SPEECH_TEXT_VERSION, SPEECH_PROTOCOL_VERSION
  ]);
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return `sha256:${Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export interface SpeechServiceOptions {
  provider: SpeechProvider;
  assets: SpeechAssetStore;
  settings: SpeechSettings;
  onMetric?(event: SpeechMetricEvent): void;
}

/** One provider attempt per call; scheduler/user controls any retry policy. */
export class SpeechService {
  private readonly controllers = new Set<AbortController>();
  private disposed = false;
  private readonly settings: SpeechSettings;
  private metric(event: SpeechMetricEvent): void {
    try { this.options.onMetric?.(event); } catch { /* Diagnostics never control audio or Provider attempts. */ }
  }
  constructor(private readonly options: SpeechServiceOptions) {
    this.settings = SpeechSettingsSchema.parse(options.settings);
  }

  /** PCM WAV needs shorter segments to stay within the shared byte limit, including slow voices. */
  get replySegmentChars(): number {
    return SPEECH_LIMITS.localReadChars;
  }

  private attempt(signal: AbortSignal): { controller: AbortController; release: () => void } {
    if (this.disposed) throw new SpeechProviderError('cancelled', 'Speech service is closed.');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    this.controllers.add(controller);
    return { controller, release: () => {
      signal.removeEventListener('abort', abort);
      this.controllers.delete(controller);
    } };
  }

  async *recognize(audio: AsyncIterable<Uint8Array>, signal: AbortSignal): AsyncIterable<AsrEvent> {
    const { controller, release } = this.attempt(signal);
    const started = performance.now();
    let bytes = 0;
    let outcome: SpeechMetricEvent['outcome'] = 'cancelled';
    const counted = async function* () { for await (const chunk of audio) { bytes += chunk.byteLength; yield chunk; } };
    try {
      let final = false;
      for await (const event of this.options.provider.asr.recognize({
        requestId: crypto.randomUUID(), format: { codec: 'pcm16le', sampleRate: 16000, channels: 1 },
        audio: counted(), signal: controller.signal
      })) { if (event.type === 'final') final = true; yield event; }
      outcome = controller.signal.aborted ? 'cancelled' : final ? 'completed' : 'failed';
    } catch (error) {
      outcome = controller.signal.aborted || error instanceof SpeechProviderError && error.code === 'cancelled' ? 'cancelled' : 'failed'; throw error;
    } finally {
      this.metric({ kind: 'asr', outcome, providerRequested: true, durationMs: performance.now() - started, audioMs: bytes / 32 });
      controller.abort(); release();
    }
  }

  async synthesize(input: { text: string; owner: AudioAssetOwner; signal: AbortSignal; maxChars?: number;
    /** Internal callers may segment already-normalized committed text. */
    alreadyNormalized?: boolean;
    /** Explicit voice tests must call the current provider even when audio exists. */
    forceProvider?: boolean }): Promise<AudioAsset> {
    const { controller, release } = this.attempt(input.signal);
    const started = performance.now();
    let providerRequested = false, requestedChars = 0, audioBytes = 0;
    let outcome: SpeechMetricEvent['outcome'] = 'cancelled';
    let writer: Awaited<ReturnType<SpeechAssetStore['begin']>> | undefined;
    try {
      const owner = AudioAssetOwnerSchema.parse(input.owner);
      const requestedMaxChars = input.maxChars ?? SPEECH_LIMITS.autoReadChars;
      if (!Number.isInteger(requestedMaxChars) || requestedMaxChars < 1 || requestedMaxChars > 10_000) throw new Error('Invalid speech text limit.');
      const maxChars = Math.min(requestedMaxChars, this.replySegmentChars);
      const text = input.alreadyNormalized === true ? Array.from(input.text).slice(0, maxChars).join('') : normalizeSpeechText(input.text, maxChars);
      if (!text.trim()) throw new SpeechProviderError('empty_result', 'There is no readable text to synthesize.');
      if (controller.signal.aborted) throw new SpeechProviderError('cancelled', 'Speech synthesis was cancelled.');
      const key = await speechCacheKey(text, this.settings);
      const existing = input.forceProvider === true ? undefined : await this.options.assets.find(key, owner);
      if (controller.signal.aborted) {
        if (existing) { try { await this.options.assets.release(existing); } catch { /* Owner cleanup and cache expiry recover this reference. */ } }
        throw new SpeechProviderError('cancelled', 'Speech synthesis was cancelled.');
      }
      if (existing) {
        if (existing.format !== this.settings.provider.tts.format || existing.sampleRate !== this.settings.provider.tts.sampleRate) {
          await this.options.assets.release(existing);
          throw new SpeechProviderError('protocol_error', 'Unexpected cached speech audio format.');
        }
        outcome = 'cache_hit'; return existing;
      }
      writer = await this.options.assets.begin(key, owner, this.settings.provider.tts.format);
      const requestId = crypto.randomUUID();
      let completed = false;
      providerRequested = true; requestedChars = Array.from(text).length;
      for await (const event of this.options.provider.tts.synthesize({
        requestId, text, speakerId: this.settings.provider.tts.speakerId,
        speechRate: this.settings.provider.tts.speechRate, signal: controller.signal
      })) {
        if (controller.signal.aborted) throw new SpeechProviderError('cancelled', 'Speech synthesis was cancelled.');
        if (event.requestId !== requestId || completed) throw new SpeechProviderError('protocol_error', 'Invalid speech event ordering.');
        if (event.type === 'audio') {
          if (event.format !== this.settings.provider.tts.format || event.sampleRate !== this.settings.provider.tts.sampleRate) {
            throw new SpeechProviderError('protocol_error', 'Unexpected speech audio format.');
          }
          await writer.append(event.bytes);
          audioBytes += event.bytes.byteLength;
        } else {
          completed = true;
        }
      }
      if (controller.signal.aborted) throw new SpeechProviderError('cancelled', 'Speech synthesis was cancelled.');
      if (!completed) throw new SpeechProviderError('protocol_error', 'Speech synthesis ended before completion.');
      const asset = await writer.complete();
      if (controller.signal.aborted) throw new SpeechProviderError('cancelled', 'Speech synthesis was cancelled.');
      outcome = 'completed'; return asset;
    } catch (error) {
      outcome = controller.signal.aborted || error instanceof SpeechProviderError && error.code === 'cancelled' ? 'cancelled' : 'failed';
      try { await writer?.abort(); } catch { /* Preserve the provider error; startup cleanup recovers orphan files. */ }
      throw error;
    } finally {
      this.metric({ kind: 'tts', outcome, providerRequested, durationMs: performance.now() - started,
        requestedChars, audioBytes });
      controller.abort(); release();
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }
}
