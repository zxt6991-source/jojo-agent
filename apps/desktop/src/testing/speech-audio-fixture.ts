/** Deterministic MPEG-2 Layer III silence, 64 kbps / 24 kHz / mono.
 * Locally constructed audio for offline playback compatibility tests. */
export function createSilentMp3Fixture(): Uint8Array {
  const frame = new Uint8Array(192);
  frame.set([0xff, 0xf3, 0x84, 0xc0]);
  const bytes = new Uint8Array(frame.byteLength * 4);
  for (let offset = 0; offset < bytes.byteLength; offset += frame.byteLength) bytes.set(frame, offset);
  return bytes;
}

/** A complete 100 ms RIFF/WAVE PCM16 file, 24 kHz mono, for offline decoding. */
export function createSilentWavFixture(): Uint8Array {
  const samples = 2400;
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const tag = (offset: number, value: string) => bytes.set(new TextEncoder().encode(value), offset);
  tag(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); tag(8, 'WAVE');
  tag(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, 24000, true); view.setUint32(28, 48000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  tag(36, 'data'); view.setUint32(40, samples * 2, true);
  return bytes;
}
