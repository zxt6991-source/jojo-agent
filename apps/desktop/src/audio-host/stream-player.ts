import { AUDIO_HOST_MAX_COMPLETE_BYTES, AUDIO_HOST_MAX_SEGMENTS, type AudioHostAck, type AudioHostCommand, type AudioHostError } from './ipc';

type StartCommand = Extract<AudioHostCommand, { type: 'play' }>;
type AppendCommand = Extract<AudioHostCommand, { type: 'append' }>;
/** One continuous WebAudio timeline with at most three accepted, unconsumed
 * segments. An empty buffer is not end-of-reading. */
export class StreamingAudioPlayer {
  private active: {
    token: string; generation: number; context: AudioContext; gain: GainNode;
    sources: Set<AudioBufferSourceNode>; accepted: number; ended: number; totalBytes: number;
    finalSegments?: number; nextTime: number; started: boolean; chain: Promise<void>;
    startTimer?: ReturnType<typeof setTimeout>;
  } | undefined;
  constructor(private readonly dependencies: { createContext(): AudioContext; acknowledge(ack: AudioHostAck): void }) {}
  receive(command: AudioHostCommand): void {
    if (command.type === 'stop') { if (this.active?.token === command.token) this.clear(); return; }
    if (command.type === 'play') {
      this.clear();
      try {
        const context = this.dependencies.createContext(), gain = context.createGain();
        gain.gain.value = command.volume; gain.connect(context.destination);
        this.active = { token: command.token, generation: command.generation, context, gain, sources: new Set(),
          accepted: 0, ended: 0, totalBytes: 0, nextTime: 0, started: false, chain: Promise.resolve() };
        this.append(command, 0);
      } catch { this.dependencies.acknowledge({ type: 'error', token: command.token, generation: command.generation, reason: 'decode_failed' }); this.clear(); }
      return;
    }
    const active = this.active;
    if (!active || command.token !== active.token || command.generation !== active.generation) return;
    if (command.type === 'append') this.append(command, command.index);
    else {
      if (active.finalSegments !== undefined || command.segments !== active.accepted) { this.fail('decode_failed'); return; }
      active.finalSegments = command.segments; this.finishIfDrained();
    }
  }
  outputDeviceChanged(): void { this.fail('output_device_changed'); }
  dispose(): void { this.clear(); }
  private append(command: StartCommand | AppendCommand, index: number): void {
    const active = this.active;
    if (!active) return;
    if (active.finalSegments !== undefined || index !== active.accepted || active.accepted >= AUDIO_HOST_MAX_SEGMENTS ||
      active.accepted - active.ended >= 3 || active.totalBytes + command.bytes.byteLength > AUDIO_HOST_MAX_COMPLETE_BYTES) { this.fail('decode_failed'); return; }
    active.accepted++; active.totalBytes += command.bytes.byteLength;
    active.chain = active.chain.then(async () => {
      if (this.active !== active) return;
      const buffer = await active.context.decodeAudioData(new Uint8Array(command.bytes).buffer);
      if (this.active !== active) return;
      if (!Number.isFinite(buffer.duration) || buffer.duration <= 0) throw new Error('empty_audio');
      if (active.context.state === 'suspended') await active.context.resume();
      if (this.active !== active) return;
      if (active.context.state !== 'running') throw new DOMException('Audio context is not running', 'NotAllowedError');
      const source = active.context.createBufferSource(); source.buffer = buffer; source.connect(active.gain);
      const startAt = Math.max(active.context.currentTime + 0.01, active.nextTime);
      active.nextTime = startAt + buffer.duration; active.sources.add(source);
      source.onended = () => {
        source.onended = null; source.disconnect();
        if (this.active !== active) return;
        active.sources.delete(source); active.ended++;
        if (!active.started) this.started(active);
        this.dependencies.acknowledge({ type: 'segment_ended', token: active.token, generation: active.generation, index });
        this.finishIfDrained();
      };
      source.start(startAt);
      if (!active.started && !active.startTimer) active.startTimer = setTimeout(() => {
        delete active.startTimer;
        if (this.active === active && active.context.state === 'running') this.started(active);
      }, Math.max(0, (startAt - active.context.currentTime) * 1000));
    }).catch((error: unknown) => {
      if (this.active === active) this.fail(error instanceof Error && error.name === 'NotAllowedError' ? 'autoplay_denied' : 'decode_failed');
    });
  }
  private started(active: NonNullable<StreamingAudioPlayer['active']>): void {
    if (active.started) return;
    active.started = true;
    this.dependencies.acknowledge({ type: 'started', token: active.token, generation: active.generation });
  }
  private finishIfDrained(): void {
    const active = this.active;
    if (!active || active.finalSegments === undefined || active.ended !== active.finalSegments) return;
    this.dependencies.acknowledge({ type: 'ended', token: active.token, generation: active.generation }); this.clear();
  }
  private fail(reason: AudioHostError): void {
    const active = this.active;
    if (!active) return;
    this.dependencies.acknowledge({ type: 'error', token: active.token, generation: active.generation, reason }); this.clear();
  }
  private clear(): void {
    const active = this.active; this.active = undefined;
    if (!active) return;
    clearTimeout(active.startTimer);
    for (const source of active.sources) { source.onended = null; try { source.stop(); } catch { /* A finished node is already silent. */ } source.disconnect(); }
    active.sources.clear(); active.gain.disconnect(); void active.context.close().catch(() => undefined);
  }
}
