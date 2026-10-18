import { randomUUID } from 'node:crypto';
import { SpeechProviderError, type SpeechTtsProvider } from '@desktop-agent/contracts';
import { pcm24kFromWav } from '@desktop-agent/speech';

export const SYNTHETIC_REFERENCE_TEXT = '这是用于本地语音评测的合成参考声音，请用自然清晰的普通话朗读。';

/** Use the real Provider request/terminal contract, including UUIDs, before
 * treating any output as a reusable synthetic voice reference. */
export async function synthesizeBenchmarkReference(provider: SpeechTtsProvider, signal: AbortSignal): Promise<Uint8Array> {
  const requestId = randomUUID();
  let wav: Uint8Array | undefined, completed = false;
  if (signal.aborted) throw new SpeechProviderError('cancelled', 'Reference synthesis cancelled.');
  for await (const event of provider.synthesize({ requestId, text: SYNTHETIC_REFERENCE_TEXT, speakerId: 'default', speechRate: 0, signal })) {
    if (signal.aborted) throw new SpeechProviderError('cancelled', 'Reference synthesis cancelled.');
    if (event.requestId !== requestId || completed) throw new SpeechProviderError('protocol_error', 'Invalid reference synthesis identity or completion.');
    if (event.type === 'completed') { completed = true; continue; }
    if (wav || event.format !== 'wav' || event.sampleRate !== 24000) throw new SpeechProviderError('invalid_audio', 'Reference requires one complete 24k WAV.');
    wav = event.bytes;
  }
  if (signal.aborted) throw new SpeechProviderError('cancelled', 'Reference synthesis cancelled.');
  if (!completed || !wav) throw new SpeechProviderError('protocol_error', 'Reference synthesis did not complete.');
  pcm24kFromWav(wav);
  return wav;
}
