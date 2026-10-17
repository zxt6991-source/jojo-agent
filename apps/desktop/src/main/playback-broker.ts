import { AudioAssetOwnerSchema, AudioAssetSchema, type AudioAsset, type AudioAssetOwner, type SpeechSettings } from '@desktop-agent/contracts';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { AudioHostAck, AudioHostError } from '../audio-host/ipc';

export interface AudioHostPort {
  play(input: { token: string; generation: number; bytes: Uint8Array; volume: number; format?: AudioAsset['format'] }): Promise<void>;
  stop(token: string): void;
  onAck(listener: (ack: AudioHostAck) => void): () => void;
  close(): void;
}
export interface PlaybackRequest {
  playbackId: string; assetId: string; owner: AudioAssetOwner; generation: number;
  expiresAt?: number; manual?: boolean; volume?: number;
}
export type PlaybackFailure = AudioHostError | 'asset_unavailable' | 'queue_full' | 'expired' | 'stale_generation';
export interface PlaybackEvent {
  playbackId: string; assetId: string; owner: AudioAssetOwner; generation: number;
  state: 'queued' | 'started' | 'played' | 'stopped' | 'suppressed' | 'failed';
  reason?: PlaybackFailure | 'recording' | 'locked' | 'disabled' | 'quiet_hours' | 'cancelled';
}
export interface ReadyPlaybackAsset { asset: AudioAsset; path: string }
export interface PlaybackBrokerOptions {
  host: AudioHostPort;
  assetsDirectory: string;
  resolveAsset(id: string, owner: AudioAssetOwner): Promise<ReadyPlaybackAsset | undefined>;
  onEvent(event: PlaybackEvent): void;
  beforePlay?(request: PlaybackRequest): Promise<boolean>;
  now?: () => number;
  maxQueued?: number;
  maxPlaybackMs?: number;
}

const ownerKey = (owner: AudioAssetOwner) => `${owner.kind}:${owner.id}`;
const explicitValidation = (request: PlaybackRequest) => request.manual === true && request.owner.kind === 'test';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** Recheck the ready manifest AND the actual file. Neither renderer paths nor
 * symlink targets can become playback input. Reads allocate a bounded buffer. */
export async function readAuthorizedPlaybackAsset(
  assetsDirectory: string, resolved: ReadyPlaybackAsset, request: PlaybackRequest, now: number
): Promise<Uint8Array> {
  const asset = AudioAssetSchema.parse(resolved.asset);
  if (asset.id !== request.assetId || ownerKey(asset.owner) !== ownerKey(request.owner) || asset.expiresAt <= now) throw new Error('asset_unavailable');
  const root = path.resolve(assetsDirectory);
  const filename = path.resolve(resolved.path);
  const name = path.basename(filename);
  if ((await lstat(root)).isSymbolicLink()) throw new Error('asset_unavailable');
  const canonicalRoot = await realpath(root);
  // Worker returns canonical paths. macOS may give Main a /var/... parent
  // alias for that same /private/var/... cache; neither form authorizes a
  // different directory, and the final cache directory itself cannot be linked.
  if (![root, canonicalRoot].includes(path.dirname(filename)) || !name.endsWith(`.${asset.format}`) || !UUID.test(name.slice(0, -4))) throw new Error('asset_unavailable');
  const canonicalFilename = path.join(canonicalRoot, name);
  const before = await lstat(canonicalFilename);
  if (!before.isFile() || before.isSymbolicLink() || before.size !== asset.bytes) throw new Error('asset_unavailable');
  const handle = await open(canonicalFilename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== asset.bytes || stat.dev !== before.dev || stat.ino !== before.ino) throw new Error('asset_unavailable');
    const buffer = new Uint8Array(asset.bytes);
    let position = 0;
    while (position < buffer.byteLength) {
      const result = await handle.read(buffer, position, buffer.byteLength - position, position);
      if (result.bytesRead === 0) throw new Error('asset_unavailable');
      position += result.bytesRead;
    }
    const extra = await handle.read(new Uint8Array(1), 0, 1, buffer.byteLength);
    if (extra.bytesRead !== 0) throw new Error('asset_unavailable');
    return buffer;
  } finally { await handle.close(); }
}

/** Main owns the sole ephemeral playback queue. Durable reminder delivery is
 * intentionally owned by the Scheduler, which can later consume these ACKs. */
export class PlaybackBroker {
  private readonly queue: PlaybackRequest[] = [];
  private readonly generations = new Map<string, number>();
  private active: { request: PlaybackRequest; token: string; deadline: number; started: boolean; timer: ReturnType<typeof setTimeout> | undefined } | undefined;
  private readonly unsubscribe: () => void;
  private readonly now: () => number;
  private policy: { enabled: boolean; recording: boolean; locked: boolean; playback: SpeechSettings['playback'] } = {
    enabled: true, recording: false, locked: false, playback: { volume: 1, muteWhenLocked: true }
  };
  private outputBlocked = false;
  private blockedReason: AudioHostError | undefined;
  private closed = false;
  constructor(private readonly options: PlaybackBrokerOptions) {
    this.now = options.now ?? Date.now;
    this.unsubscribe = options.host.onAck((ack) => this.acknowledge(ack));
  }
  enqueue(input: PlaybackRequest): void {
    if (this.closed) throw new Error('playback_broker_closed');
    const owner = AudioAssetOwnerSchema.parse(input.owner);
    if (!UUID.test(input.assetId) || !input.playbackId || input.playbackId.length > 256 ||
      !Number.isSafeInteger(input.generation) || input.generation < 0 ||
      (input.expiresAt !== undefined && (!Number.isSafeInteger(input.expiresAt) || input.expiresAt < 0)) ||
      (input.volume !== undefined && (!Number.isFinite(input.volume) || input.volume < 0 || input.volume > 1))) throw new Error('invalid_playback_request');
    const request = { ...input, owner };
    if (this.active?.request.playbackId === request.playbackId || this.queue.some((item) => item.playbackId === request.playbackId)) return;
    if (this.outputBlocked && !request.manual) {
      this.emit(request, 'suppressed', this.blockedReason ?? 'host_unavailable'); return;
    }
    const generation = this.generations.get(ownerKey(owner));
    if (generation !== undefined && request.generation < generation) { this.emit(request, 'failed', 'stale_generation'); return; }
    if (generation !== undefined && request.generation > generation) this.invalidateOwner(owner, request.generation);
    this.generations.set(ownerKey(owner), request.generation);
    if (this.queue.length >= (this.options.maxQueued ?? 20)) { this.emit(request, 'failed', 'queue_full'); return; }
    this.queue.push(request); this.emit(request, 'queued'); void this.pump();
  }
  setPolicy(policy: Partial<Pick<typeof this.policy, 'enabled' | 'recording' | 'locked' | 'playback'>>): void {
    this.policy = { ...this.policy, ...policy };
    if (this.active) {
      if (!this.policy.enabled && !explicitValidation(this.active.request)) this.finish('suppressed', 'disabled');
      else if (this.policy.recording) this.finish('stopped', 'recording');
      else if (this.policy.locked && this.policy.playback.muteWhenLocked) this.finish('suppressed', 'locked');
      else if (!this.active.request.manual && this.inQuietHours()) this.finish('suppressed', 'quiet_hours');
    }
    void this.pump();
  }
  /** Called on conversation switches/deletion/cancellation before new requests. */
  invalidateOwner(owner: AudioAssetOwner, generation: number): void {
    AudioAssetOwnerSchema.parse(owner);
    if (!Number.isSafeInteger(generation) || generation < 0) throw new Error('invalid_playback_generation');
    this.generations.set(ownerKey(owner), generation);
    this.removeQueued((request) => ownerKey(request.owner) === ownerKey(owner), 'cancelled');
    if (this.active && ownerKey(this.active.request.owner) === ownerKey(owner)) this.finish('stopped', 'cancelled');
    void this.pump();
  }
  /** Stopping sound never invokes the Agent Run cancellation path. */
  stop(playbackId?: string): void {
    this.removeQueued((request) => playbackId === undefined || request.playbackId === playbackId, 'cancelled');
    if (this.active && (playbackId === undefined || this.active.request.playbackId === playbackId)) this.finish('stopped', 'cancelled');
    void this.pump();
  }
  resumeOutput(): void {
    // A user retry authorizes the new request, never a backlog that was held
    // after an output-device/privacy failure. Healthy queues remain serial.
    if (this.outputBlocked) this.removeQueued(() => true, 'cancelled');
    this.outputBlocked = false; this.blockedReason = undefined; void this.pump();
  }
  close(): void {
    this.closed = true; this.stop(); this.unsubscribe(); this.options.host.close(); this.generations.clear();
  }
  private emit(request: PlaybackRequest, state: PlaybackEvent['state'], reason?: PlaybackEvent['reason']): void {
    this.options.onEvent({ playbackId: request.playbackId, assetId: request.assetId, owner: request.owner,
      generation: request.generation, state, ...(reason ? { reason } : {}) });
  }
  private removeQueued(match: (request: PlaybackRequest) => boolean, reason: 'cancelled'): void {
    for (let index = this.queue.length - 1; index >= 0; index--) {
      const request = this.queue[index]!;
      if (match(request)) { this.queue.splice(index, 1); this.emit(request, 'stopped', reason); }
    }
  }
  private finish(state: PlaybackEvent['state'], reason?: PlaybackEvent['reason']): void {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    clearTimeout(active.timer);
    if (state !== 'played') this.options.host.stop(active.token);
    this.emit(active.request, state, reason);
  }
  private inQuietHours(): boolean {
    const hours = this.policy.playback.quietHours;
    if (!hours) return false;
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: hours.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(this.now());
    const time = `${parts.find((item) => item.type === 'hour')?.value}:${parts.find((item) => item.type === 'minute')?.value}`;
    return hours.start <= hours.end ? time >= hours.start && time < hours.end : time >= hours.start || time < hours.end;
  }
  private async pump(): Promise<void> {
    if (this.closed || this.active || this.policy.recording || this.outputBlocked || (this.policy.locked && this.policy.playback.muteWhenLocked)) return;
    const request = this.queue.shift();
    if (!request) return;
    if (request.expiresAt !== undefined && request.expiresAt <= this.now()) { this.emit(request, 'failed', 'expired'); void this.pump(); return; }
    if ((!this.policy.enabled && !explicitValidation(request)) || (!request.manual && this.inQuietHours())) {
      this.emit(request, 'suppressed', !this.policy.enabled && !explicitValidation(request) ? 'disabled' : 'quiet_hours'); void this.pump(); return;
    }
    const active = { request, token: randomUUID(), deadline: this.now() + (this.options.maxPlaybackMs ?? 300_000), started: false,
      timer: undefined as ReturnType<typeof setTimeout> | undefined };
    this.active = active;
    active.timer = setTimeout(() => {
      if (this.active !== active) return;
      this.finish('failed', 'asset_unavailable'); void this.pump();
    }, 15_000);
    try {
      const resolved = await this.options.resolveAsset(request.assetId, request.owner);
      if (this.active !== active) return;
      if (!resolved) throw new Error('asset_unavailable');
      const bytes = await readAuthorizedPlaybackAsset(this.options.assetsDirectory, resolved, request, this.now());
      if (this.active !== active) return;
      // A durable reminder must persist permission to start before AudioHost can emit sound.
      if (this.options.beforePlay && !await this.options.beforePlay(request)) {
        if (this.active === active) { this.finish('failed', 'asset_unavailable'); void this.pump(); }
        return;
      }
      if (this.active !== active) return;
      active.deadline = Math.min(active.deadline, resolved.asset.expiresAt, request.expiresAt ?? Infinity);
      if (active.deadline <= this.now()) { this.finish('failed', 'expired'); void this.pump(); return; }
      clearTimeout(active.timer);
      active.timer = setTimeout(() => {
        if (this.active !== active) return;
        this.finish('failed', 'playback_timeout'); void this.pump();
      }, active.deadline - this.now());
      await this.options.host.play({ token: active.token, generation: request.generation, bytes, format: resolved.asset.format,
        volume: request.volume ?? this.policy.playback.volume });
    } catch {
      if (this.active !== active) return;
      this.finish('failed', 'asset_unavailable'); void this.pump();
    }
  }
  private acknowledge(ack: AudioHostAck): void {
    const active = this.active;
    if (!active || ack.token !== active.token || ack.generation !== active.request.generation || active.deadline <= this.now()) return;
    if (ack.type === 'started') {
      if (!active.started) { active.started = true; this.emit(active.request, 'started'); }
    } else if (ack.type === 'ended') {
      if (!active.started) return;
      this.finish('played'); void this.pump();
    } else {
      this.outputBlocked = ack.reason === 'output_device_changed' || ack.reason === 'host_crashed' || ack.reason === 'autoplay_denied';
      this.blockedReason = this.outputBlocked ? ack.reason : undefined;
      this.finish('failed', ack.reason); void this.pump();
    }
  }
}
