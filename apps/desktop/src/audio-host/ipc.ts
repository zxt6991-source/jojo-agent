/** This bridge belongs only to the hidden AudioHost. It exposes no Desktop API. */
export const AUDIO_HOST_COMMAND = 'jojo.audio-host.command';
export const AUDIO_HOST_ACK = 'jojo.audio-host.ack';
export const AUDIO_HOST_READY = 'jojo.audio-host.ready';
export const AUDIO_HOST_MAX_BYTES = 8 * 1024 * 1024;
/** Fully prepared readings are still bounded; each source asset remains <= 8 MiB. */
export const AUDIO_HOST_MAX_COMPLETE_BYTES = 64 * 1024 * 1024;
export const AUDIO_HOST_MAX_SEGMENTS = 128;
export type AudioHostFormat = 'mp3' | 'wav';
export type AudioHostError = 'autoplay_denied' | 'decode_failed' | 'output_device_changed' | 'host_crashed' | 'host_unavailable' | 'playback_timeout';
export type AudioHostCommand =
  | { type: 'play'; token: string; generation: number; bytes: Uint8Array; volume: number; format?: AudioHostFormat; complete?: true; stream?: true }
  | { type: 'append'; token: string; generation: number; index: number; bytes: Uint8Array; format: AudioHostFormat }
  | { type: 'finish'; token: string; generation: number; segments: number }
  | { type: 'stop'; token: string };
export type AudioHostAck = { token: string; generation: number } & (
  | { type: 'started' }
  | { type: 'ended' }
  | { type: 'segment_ended'; index: number }
  | { type: 'error'; reason: AudioHostError }
);
export type AudioHostAppendInput = Omit<Extract<AudioHostCommand, { type: 'append' }>, 'type'>;
export type AudioHostPlayInput = Omit<Extract<AudioHostCommand, { type: 'play' }>, 'type'>;
export interface AudioHostBridge {
  onCommand(listener: (command: AudioHostCommand) => void): () => void;
  acknowledge(ack: AudioHostAck): void;
  ready(): void;
}
const TOKEN = /^[a-f0-9-]{36}$/u;
export function isAudioHostCommand(value: unknown): value is AudioHostCommand {
  if (!value || typeof value !== 'object') return false;
  const input = value as Record<string, unknown>;
  if (typeof input.token !== 'string' || !TOKEN.test(input.token)) return false;
  if (input.type === 'stop') return Object.keys(input).length === 2;
  const generation = Number.isSafeInteger(input.generation) && (input.generation as number) >= 0;
  if (input.type === 'finish') return Object.keys(input).length === 4 && generation && Number.isSafeInteger(input.segments) && (input.segments as number) > 0 && (input.segments as number) <= AUDIO_HOST_MAX_SEGMENTS;
  if (input.type === 'append') return Object.keys(input).length === 6 && generation && Number.isSafeInteger(input.index) && (input.index as number) > 0 && (input.index as number) < AUDIO_HOST_MAX_SEGMENTS &&
    (input.format === 'wav' || input.format === 'mp3') && input.bytes instanceof Uint8Array && input.bytes.byteLength > 0 && input.bytes.byteLength <= AUDIO_HOST_MAX_BYTES;
  return input.type === 'play' && Object.keys(input).length === 5 + Number('format' in input) + Number('complete' in input) + Number('stream' in input) &&
    (!('stream' in input) || (input.stream === true && !('complete' in input))) &&
    (!('format' in input) || input.format === 'mp3' || input.format === 'wav') &&
    (!('complete' in input) || (input.complete === true && input.format === 'wav')) &&
    Number.isSafeInteger(input.generation) && (input.generation as number) >= 0 &&
    input.bytes instanceof Uint8Array && input.bytes.byteLength > 0 && input.bytes.byteLength <= (input.complete ? AUDIO_HOST_MAX_COMPLETE_BYTES : AUDIO_HOST_MAX_BYTES) &&
    typeof input.volume === 'number' && Number.isFinite(input.volume) && input.volume >= 0 && input.volume <= 1;
}
export function isAudioHostAck(value: unknown): value is AudioHostAck {
  if (!value || typeof value !== 'object') return false;
  const input = value as Record<string, unknown>;
  if (typeof input.token !== 'string' || !TOKEN.test(input.token) ||
    !Number.isSafeInteger(input.generation) || (input.generation as number) < 0) return false;
  if (input.type === 'segment_ended') return Object.keys(input).length === 4 && Number.isSafeInteger(input.index) && (input.index as number) >= 0 && (input.index as number) < AUDIO_HOST_MAX_SEGMENTS;
  if (input.type === 'started' || input.type === 'ended') return Object.keys(input).length === 3;
  return input.type === 'error' && Object.keys(input).length === 4 &&
    ['autoplay_denied', 'decode_failed', 'output_device_changed', 'host_crashed', 'host_unavailable', 'playback_timeout'].includes(String(input.reason));
}
