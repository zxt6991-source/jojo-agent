/** Local stdio framing. PCM stays binary; transcripts never enter diagnostic logs. */
export const SIDECAR_PROTOCOL_VERSION = 1;
export const SIDECAR_MAX_FRAME_BYTES = 1_048_576;
export const SIDECAR_MAX_HEADER_BYTES = 16_384;

export interface VoiceCaptureContext {
  voiceSessionId: string;
  captureId: string;
  turnId: string;
  generation: number;
}
export interface SidecarCapability { available: boolean; reason?: string }
export interface SidecarCapabilities {
  vad: SidecarCapability;
  streamingAsr: SidecarCapability;
  smartTurn: SidecarCapability;
}
export type SidecarControl =
  | ({ type: 'session.open' | 'session.close' | 'turn.reset' | 'turn.finish' | 'cancel' } & VoiceCaptureContext)
  | ({ type: 'audio.frame'; sequence: number; sampleRate: 16000; channels: 1 } & VoiceCaptureContext)
  | { type: 'shutdown' };
export type SidecarEvent =
  | { type: 'ready'; protocolVersion: 1; capabilities: SidecarCapabilities }
  | ({ type: 'session.opened' | 'session.closed' | 'turn.reset' } & VoiceCaptureContext)
  | ({ type: 'audio.ack'; sequence: number } & VoiceCaptureContext)
  | ({ type: 'audio.gap'; missingFrames: number; turnReset: boolean } & VoiceCaptureContext)
  | ({ type: 'vad.started' | 'vad.stopped'; atMs: number } & VoiceCaptureContext)
  | ({ type: 'asr.partial' | 'asr.final'; text: string } & VoiceCaptureContext)
  | ({ type: 'turn.complete' | 'turn.incomplete'; score: number; inferenceMs: number } & VoiceCaptureContext)
  | ({ type: 'turn.unavailable'; code: 'inference_failed' } & VoiceCaptureContext)
  | ({ type: 'error'; code: string; fatal?: boolean } & Partial<VoiceCaptureContext>);

export interface SidecarFrame<T = Record<string, unknown>> { header: T; body: Uint8Array }
export function sameVoiceCapture(a: VoiceCaptureContext, b: VoiceCaptureContext): boolean {
  return a.voiceSessionId === b.voiceSessionId && a.captureId === b.captureId && a.turnId === b.turnId && a.generation === b.generation;
}
export function isVoiceCaptureContext(value: unknown): value is VoiceCaptureContext {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return ['voiceSessionId', 'captureId', 'turnId'].every(key => typeof v[key] === 'string' && (v[key] as string).length > 0 && (v[key] as string).length <= 256)
    && Number.isSafeInteger(v.generation) && (v.generation as number) >= 0;
}
export function encodeSidecarFrame(header: object, body: Uint8Array = new Uint8Array()): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const length = 4 + json.length + body.length;
  if (!json.length || json.length > SIDECAR_MAX_HEADER_BYTES || length > SIDECAR_MAX_FRAME_BYTES) throw new Error('Invalid sidecar frame size.');
  const frame = new Uint8Array(length + 4);
  const view = new DataView(frame.buffer);
  view.setUint32(0, length); view.setUint32(4, json.length);
  frame.set(json, 8); frame.set(body, 8 + json.length);
  return frame;
}
/** Parses arbitrarily split/coalesced pipe reads with a strict allocation bound. */
export class SidecarFrameDecoder {
  private pending = new Uint8Array();
  push(bytes: Uint8Array): SidecarFrame[] {
    const frames: SidecarFrame[] = [];
    let offset = 0;
    while (offset < bytes.length) {
      const target = this.pending.length < 4 ? 4 : 4 + new DataView(this.pending.buffer, this.pending.byteOffset, this.pending.byteLength).getUint32(0);
      const take = Math.min(target - this.pending.length, bytes.length - offset);
      const next = new Uint8Array(this.pending.length + take);
      next.set(this.pending); next.set(bytes.subarray(offset, offset + take), this.pending.length);
      this.pending = next; offset += take;
      if (this.pending.length < 4) continue;
      const view = new DataView(this.pending.buffer, this.pending.byteOffset, this.pending.byteLength);
      const length = view.getUint32(0);
      if (length < 6 || length > SIDECAR_MAX_FRAME_BYTES) { this.pending = new Uint8Array(); throw new Error('Invalid sidecar frame length.'); }
      if (this.pending.length < length + 4) continue;
      const headerLength = view.getUint32(4);
      if (!headerLength || headerLength > SIDECAR_MAX_HEADER_BYTES || headerLength > length - 4) throw new Error('Invalid sidecar header length.');
      const header: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(this.pending.subarray(8, 8 + headerLength)));
      if (!header || typeof header !== 'object' || Array.isArray(header)) throw new Error('Invalid sidecar header.');
      frames.push({ header: header as Record<string, unknown>, body: this.pending.slice(8 + headerLength) });
      this.pending = new Uint8Array();
    }
    return frames;
  }
  finish(): void { if (this.pending.length) throw new Error('Truncated sidecar frame.'); }
}

export function parseSidecarEvent(value: unknown): SidecarEvent {
  if (!value || typeof value !== 'object') throw new Error('Invalid sidecar event.');
  const v = value as Record<string, unknown>;
  if (v.type === 'ready') {
    const caps = v.capabilities as Partial<SidecarCapabilities> | undefined;
    if (v.protocolVersion !== SIDECAR_PROTOCOL_VERSION || !caps || !['vad', 'streamingAsr', 'smartTurn'].every(key => {
      const cap = caps[key as keyof SidecarCapabilities];
      return cap && typeof cap.available === 'boolean' && (cap.reason === undefined || typeof cap.reason === 'string');
    })) throw new Error('Incompatible sidecar capabilities.');
    return v as unknown as SidecarEvent;
  }
  if (v.type === 'error' && typeof v.code === 'string' && v.code.length <= 128) {
    if (v.voiceSessionId !== undefined && !isVoiceCaptureContext(v)) throw new Error('Invalid sidecar error context.');
    return v as unknown as SidecarEvent;
  }
  if (!isVoiceCaptureContext(v)) throw new Error('Missing sidecar generation context.');
  switch (v.type) {
    case 'session.opened': case 'session.closed': case 'turn.reset': break;
    case 'audio.ack': if (!Number.isSafeInteger(v.sequence) || (v.sequence as number) < 0) throw new Error('Invalid ACK.'); break;
    case 'audio.gap': if (!Number.isSafeInteger(v.missingFrames) || (v.missingFrames as number) < 1 || typeof v.turnReset !== 'boolean') throw new Error('Invalid gap.'); break;
    case 'vad.started': case 'vad.stopped': if (typeof v.atMs !== 'number' || !Number.isFinite(v.atMs) || v.atMs < 0) throw new Error('Invalid VAD timestamp.'); break;
    case 'asr.partial': case 'asr.final': if (typeof v.text !== 'string' || v.text.length > 32_768) throw new Error('Invalid transcript.'); break;
    case 'turn.complete': case 'turn.incomplete': if (typeof v.score !== 'number' || !Number.isFinite(v.score) || v.score < 0 || v.score > 1 || typeof v.inferenceMs !== 'number' || !Number.isFinite(v.inferenceMs) || v.inferenceMs < 0) throw new Error('Invalid turn decision.'); break;
    case 'turn.unavailable': if (v.code !== 'inference_failed') throw new Error('Invalid turn failure.'); break;
    default: throw new Error('Unknown sidecar event.');
  }
  return v as unknown as SidecarEvent;
}
