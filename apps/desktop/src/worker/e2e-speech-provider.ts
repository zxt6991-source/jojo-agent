import { SpeechProviderError, type SpeechProvider } from '@desktop-agent/contracts';
import { createSilentWavFixture } from '../testing/speech-audio-fixture';

/** Deliberate offline test injection. Production callers must never select this
 * as a fallback for a missing model, failed subprocess, or invalid response. */
export function createE2eSpeechProvider(): SpeechProvider {
  return {
    asr: { async *recognize(input) {
      if (input.signal.aborted) throw new SpeechProviderError('cancelled', 'Offline speech recognition cancelled.');
      yield { type: 'ready', requestId: input.requestId };
      let bytes = 0;
      for await (const chunk of input.audio) {
        if (input.signal.aborted) throw new SpeechProviderError('cancelled', 'Offline speech recognition cancelled.');
        bytes += chunk.byteLength;
      }
      if (!bytes) throw new SpeechProviderError('invalid_audio', 'Offline speech recognition requires audio.');
      if (input.signal.aborted) throw new SpeechProviderError('cancelled', 'Offline speech recognition cancelled.');
      yield { type: 'final', requestId: input.requestId, text: 'E2E: text', durationMs: bytes / 32 };
    } },
    tts: { async *synthesize(input) {
      if (input.signal.aborted) throw new SpeechProviderError('cancelled', 'Offline speech synthesis cancelled.');
      yield { type: 'audio', requestId: input.requestId, bytes: createSilentWavFixture(), format: 'wav', sampleRate: 24000 };
      if (input.signal.aborted) throw new SpeechProviderError('cancelled', 'Offline speech synthesis cancelled.');
      yield { type: 'completed', requestId: input.requestId };
    } }
  };
}
