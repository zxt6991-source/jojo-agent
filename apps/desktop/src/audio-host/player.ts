import type { AudioHostAck, AudioHostCommand, AudioHostFormat } from './ipc';

export interface AudioElementPort {
  src: string;
  volume: number;
  play(): Promise<void>;
  pause(): void;
  removeAttribute(name: string): void;
  load(): void;
  addEventListener(name: string, listener: () => void): void;
  removeEventListener(name: string, listener: () => void): void;
}
/** A single element and Blob are alive at a time; old element callbacks are fenced. */
export class AudioHostPlayer {
  private current: { token: string; generation: number; audio: AudioElementPort; url: string; cleanup(): void } | undefined;
  constructor(private readonly dependencies: {
    createAudio(): AudioElementPort;
    createUrl(bytes: Uint8Array, format: AudioHostFormat): string;
    revokeUrl(url: string): void;
    acknowledge(ack: AudioHostAck): void;
  }) {}

  receive(command: AudioHostCommand): void {
    if (command.type === 'stop') { if (this.current?.token === command.token) this.clear(); return; }
    this.clear();
    const audio = this.dependencies.createAudio();
    const url = this.dependencies.createUrl(command.bytes, command.format ?? 'mp3');
    const ack = (type: 'started' | 'ended') => {
      if (this.current?.audio !== audio) return;
      this.dependencies.acknowledge({ type, token: command.token, generation: command.generation });
      if (type === 'ended') this.clear();
    };
    const playing = () => ack('started');
    const ended = () => ack('ended');
    const error = () => this.fail('decode_failed');
    audio.addEventListener('playing', playing); audio.addEventListener('ended', ended); audio.addEventListener('error', error);
    this.current = { token: command.token, generation: command.generation, audio, url,
      cleanup() {
        audio.removeEventListener('playing', playing); audio.removeEventListener('ended', ended); audio.removeEventListener('error', error);
      }
    };
    audio.volume = command.volume; audio.src = url;
    void audio.play().catch((reason: unknown) => {
      if (this.current?.audio !== audio) return;
      const denied = reason instanceof Error && reason.name === 'NotAllowedError';
      this.fail(denied ? 'autoplay_denied' : 'decode_failed');
    });
  }
  outputDeviceChanged(): void { this.fail('output_device_changed'); }
  dispose(): void { this.clear(); }
  private fail(reason: 'output_device_changed' | 'autoplay_denied' | 'decode_failed'): void {
    const active = this.current;
    if (!active) return;
    this.dependencies.acknowledge({ type: 'error', token: active.token, generation: active.generation, reason });
    this.clear();
  }
  private clear(): void {
    const active = this.current;
    this.current = undefined;
    if (!active) return;
    active.cleanup(); active.audio.pause(); active.audio.removeAttribute('src'); active.audio.load();
    this.dependencies.revokeUrl(active.url);
  }
}
