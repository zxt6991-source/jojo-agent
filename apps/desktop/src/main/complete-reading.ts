import { pcm24kFromWav } from '@desktop-agent/speech';
import { AUDIO_HOST_MAX_COMPLETE_BYTES, AUDIO_HOST_MAX_SEGMENTS } from '../audio-host/ipc';

/** Join only authorized, complete PCM assets. One WAV and one Audio element keep
 * synthesis, IPC round trips and decoder restarts out of the audible timeline. */
export function completeReadingAudio(segments: readonly Uint8Array[]): { bytes: Uint8Array; durationMs: number } {
  if (!segments.length || segments.length > AUDIO_HOST_MAX_SEGMENTS) throw new Error('invalid_reading_audio');
  const chunks = segments.map(pcm24kFromWav);
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  if (size + 44 > AUDIO_HOST_MAX_COMPLETE_BYTES) throw new Error('reading_audio_too_large');
  const bytes = new Uint8Array(44 + size), view = new DataView(bytes.buffer);
  const tag = (offset: number, text: string) => bytes.set(new TextEncoder().encode(text), offset);
  tag(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); tag(8, 'WAVE');
  tag(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 24000, true); view.setUint32(28, 48000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  tag(36, 'data'); view.setUint32(40, size, true);
  let offset = 44;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { bytes, durationMs: size / 48 };
}
