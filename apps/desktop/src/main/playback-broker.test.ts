import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AudioAsset, AudioAssetOwner } from '@desktop-agent/contracts';
import { PlaybackBroker, readAuthorizedPlaybackAsset, type AudioHostPort, type PlaybackEvent, type PlaybackRequest } from './playback-broker';
import type { AudioHostAck } from '../audio-host/ipc';
import { createSilentWavFixture } from '../testing/speech-audio-fixture';

const directories: string[] = [], brokers: PlaybackBroker[] = [];
afterEach(async () => {
  brokers.splice(0).forEach((broker) => broker.close()); vi.useRealTimers();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function setup(beforePlay?: (request: PlaybackRequest) => Promise<boolean>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'playback-')); directories.push(directory);
  const assetsDirectory = path.join(directory, 'speech-assets'); await mkdir(assetsDirectory);
  const owner: AudioAssetOwner = { kind: 'session', id: 'session-one' };
  const bytes = new Uint8Array([0xff, 0xfb, 1, 2]);
  const filename = path.join(assetsDirectory, `${randomUUID()}.mp3`); await writeFile(filename, bytes);
  const asset: AudioAsset = { id: randomUUID(), owner, bytes: bytes.length, createdAt: 1000, expiresAt: 100_000, sampleRate: 24000, format: 'mp3' };
  let now = 2000;
  let listener: (ack: AudioHostAck) => void = () => undefined;
  const host: AudioHostPort = {
    play: vi.fn(async () => undefined), append: vi.fn(), finish: vi.fn(), stop: vi.fn(), close: vi.fn(),
    onAck(value) { listener = value; return () => { listener = () => undefined; }; }
  };
  const events: PlaybackEvent[] = [];
  const resolveAsset = vi.fn(async () => ({ asset, path: filename }));
  const broker = new PlaybackBroker({ host, assetsDirectory, resolveAsset, onEvent: (event) => events.push(event), now: () => now,
    ...(beforePlay ? { beforePlay } : {}) }); brokers.push(broker);
  const request = (id = randomUUID()): PlaybackRequest => ({ playbackId: id, assetId: asset.id, owner, generation: 1 });
  const active = () => vi.mocked(host.play).mock.calls.at(-1)![0];
  const ack = (type: 'started' | 'ended') => listener({ type, token: active().token, generation: 1 });
  return { directory, assetsDirectory, owner, bytes, filename, asset, host, broker, events, resolveAsset, request, active, ack,
    receive: (input: AudioHostAck) => listener(input), setNow: (value: number) => { now = value; } };
}
describe('Main playback broker', () => {
  it('prefetches at most three segments and requires finish plus all consumed receipts before played', async () => {
    const h = await setup(); let remaining = 4;
    const nextAsset = vi.fn(async () => remaining-- > 0 ? h.asset.id : undefined);
    h.broker.enqueue({ ...h.request(), manual: true, nextAsset });
    await vi.waitFor(() => expect(h.host.append).toHaveBeenCalledTimes(2));
    expect(nextAsset).toHaveBeenCalledTimes(2); expect(h.active()).toMatchObject({ stream: true });
    const consumed = (index: number) => h.receive({ type: 'segment_ended', token: h.active().token, generation: 1, index });
    h.ack('started'); h.ack('ended'); expect(h.events.some(event => event.state === 'played')).toBe(false);
    consumed(3); expect(nextAsset).toHaveBeenCalledTimes(2);
    consumed(0); await vi.waitFor(() => expect(h.host.append).toHaveBeenCalledTimes(3));
    consumed(0); expect(nextAsset).toHaveBeenCalledTimes(3);
    consumed(1); await vi.waitFor(() => expect(h.host.append).toHaveBeenCalledTimes(4));
    consumed(2); await vi.waitFor(() => expect(h.host.finish).toHaveBeenCalledWith(h.active().token, 1, 5));
    h.ack('ended'); expect(h.events.some(event => event.state === 'played')).toBe(false);
    consumed(3); consumed(4); h.ack('ended'); expect(h.events.at(-1)?.state).toBe('played');
  });
  it('stops an incomplete stream on producer failure and fences late consumption', async () => {
    const h = await setup(); const nextAsset = vi.fn(async (): Promise<string | undefined> => { throw new Error('synthesis_failed'); });
    h.broker.enqueue({ ...h.request(), manual: true, nextAsset });
    await vi.waitFor(() => expect(h.events.at(-1)?.state).toBe('failed'));
    expect(h.host.stop).toHaveBeenCalledOnce(); h.ack('started'); h.ack('ended');
    expect(h.events.some(event => event.state === 'played')).toBe(false);
  });
  it('rejects a later stream asset belonging to another owner', async () => {
    const h = await setup();
    h.resolveAsset.mockResolvedValueOnce({ asset: h.asset, path: h.filename }).mockResolvedValue({ asset: { ...h.asset, owner: { kind: 'session', id: 'other' } }, path: h.filename });
    h.broker.enqueue({ ...h.request(), manual: true, nextAsset: async () => h.asset.id });
    await vi.waitFor(() => expect(h.events.at(-1)?.state).toBe('failed'));
    expect(h.host.play).toHaveBeenCalledOnce(); expect(h.host.append).not.toHaveBeenCalled(); expect(h.host.stop).toHaveBeenCalledOnce();
  });
  it('defers queued reminders until interactive speech is idle without falsely delivering an interrupted asset', async () => {
    const h = await setup(); h.asset.owner = { kind: 'schedule', id: 'schedule-one' };
    const first = { ...h.request(), owner: h.asset.owner }, second = { ...h.request(), owner: h.asset.owner };
    h.broker.setInteractiveActive(true); h.broker.enqueue(first); h.broker.enqueue(second);
    expect(h.host.play).not.toHaveBeenCalled(); expect(h.events.map(event => event.state)).toEqual(['queued', 'queued']);
    h.broker.setInteractiveActive(false); await vi.waitFor(() => expect(h.host.play).toHaveBeenCalledOnce());
    h.broker.setInteractiveActive(true); expect(h.events.some(event => event.playbackId === first.playbackId && event.state === 'played')).toBe(false);
    h.broker.setInteractiveActive(false); await vi.waitFor(() => expect(h.host.play).toHaveBeenCalledTimes(2));
    expect(h.events.filter(event => event.playbackId === second.playbackId).map(event => event.state)).toEqual(['queued']);
  });
  it('forwards bounded WAV bytes and their format after exact file authorization', async () => {
    const h = await setup(); const bytes = createSilentWavFixture(); const filename = h.filename.replace(/\.mp3$/u, '.wav');
    await writeFile(filename, bytes); h.asset.format = 'wav'; h.asset.bytes = bytes.byteLength;
    h.resolveAsset.mockResolvedValueOnce({ asset: h.asset, path: filename });
    h.broker.enqueue(h.request()); await vi.waitFor(() => expect(h.host.play).toHaveBeenCalledOnce());
    expect(h.active()).toMatchObject({ bytes, format: 'wav' }); expect(h.active()).not.toHaveProperty('path');
  });
  it('validates the ready asset and waits for durable permission before invoking the audio host', async () => {
    let allow!: (value: boolean) => void;
    const gate = vi.fn(() => new Promise<boolean>(resolve => { allow = resolve; }));
    const { broker, request, host, events, asset } = await setup(gate);
    asset.owner = { kind: 'schedule', id: 'schedule-one' };
    const scheduled = { ...request(), owner: asset.owner };
    broker.enqueue(scheduled);
    await vi.waitFor(() => expect(gate).toHaveBeenCalledWith(scheduled));
    expect(host.play).not.toHaveBeenCalled();
    expect(events.map(event => event.state)).toEqual(['queued']);
    allow(true); await vi.waitFor(() => expect(host.play).toHaveBeenCalledOnce());
    expect(events.some(event => event.state === 'played')).toBe(false);
  });
  it.each(['rejected', 'failed'] as const)('never invokes audio output if the durable permission is %s', async reason => {
    const gate = vi.fn(async () => { if (reason === 'failed') throw new Error('Worker exited'); return false; });
    const { broker, request, host, events } = await setup(gate);
    broker.enqueue(request());
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ state: 'failed', reason: 'asset_unavailable' }));
    expect(host.play).not.toHaveBeenCalled();
  });
  it.each(['stop', 'recording', 'close'] as const)('fences permission that arrives after %s cancelled the request', async cancellation => {
    let allow!: (value: boolean) => void;
    const gate = vi.fn(() => new Promise<boolean>(resolve => { allow = resolve; }));
    const { broker, request, host, events } = await setup(gate);
    const scheduled = request(); broker.enqueue(scheduled);
    await vi.waitFor(() => expect(gate).toHaveBeenCalledOnce());
    if (cancellation === 'stop') broker.stop(scheduled.playbackId);
    else if (cancellation === 'recording') broker.setPolicy({ recording: true });
    else broker.close();
    allow(true); await Promise.resolve(); await Promise.resolve();
    expect(host.play).not.toHaveBeenCalled();
    expect(events.at(-1)?.state).toBe('stopped');
  });
  it('does not request durable permission for an unauthorized asset', async () => {
    const gate = vi.fn(async () => true);
    const { broker, request, host, events, asset } = await setup(gate);
    asset.owner = { kind: 'schedule', id: 'other-schedule' };
    broker.enqueue(request());
    await vi.waitFor(() => expect(events.at(-1)?.state).toBe('failed'));
    expect(gate).not.toHaveBeenCalled(); expect(host.play).not.toHaveBeenCalled();
  });
  it('serializes playback and marks played only after actual ended ACK', async () => {
    const { broker, request, host, events, ack, active, receive } = await setup();
    const first = request(), second = request(); broker.enqueue(first); broker.enqueue(second);
    await vi.waitFor(() => expect(host.play).toHaveBeenCalledTimes(1));
    const firstToken = active().token;
    ack('ended'); expect(events.filter((event) => event.state === 'played')).toHaveLength(0);
    receive({ type: 'started', token: firstToken, generation: 2 });
    receive({ type: 'ended', token: randomUUID(), generation: 1 });
    expect(events.filter((event) => event.state === 'started')).toHaveLength(0);
    ack('started'); ack('ended');
    await vi.waitFor(() => expect(host.play).toHaveBeenCalledTimes(2));
    receive({ type: 'ended', token: firstToken, generation: 1 });
    expect(events.filter((event) => event.state === 'played').map((event) => event.playbackId)).toEqual([first.playbackId]);
    ack('started'); ack('ended');
    expect(events.filter((event) => event.state === 'played')).toHaveLength(2);
  });
  it('cancels a cold pending resolve and invalidates prior generation before it can play', async () => {
    const { broker, request, host, owner, resolveAsset, asset, filename, events } = await setup();
    let resolve!: (value: { asset: AudioAsset; path: string }) => void;
    resolveAsset.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    broker.enqueue(request()); broker.invalidateOwner(owner, 2); resolve({ asset, path: filename });
    await Promise.resolve(); await Promise.resolve();
    expect(host.play).not.toHaveBeenCalled(); expect(events.at(-1)?.state).toBe('stopped');
    broker.enqueue(request()); expect(events.at(-1)?.reason).toBe('stale_generation');
  });
  it('accepts newer generations, rejects lower ones, and allows explicit replay within the latest generation', async () => {
    const { broker, request, host, events, active, receive } = await setup();
    broker.enqueue(request()); await vi.waitFor(() => expect(host.play).toHaveBeenCalledOnce());
    const oldToken = active().token;
    broker.enqueue({ ...request(), generation: 2 }); await vi.waitFor(() => expect(host.play).toHaveBeenCalledTimes(2));
    expect(host.stop).toHaveBeenCalledWith(oldToken);
    receive({ type: 'ended', token: oldToken, generation: 1 });
    expect(events.some((event) => event.state === 'played')).toBe(false);
    broker.enqueue(request()); expect(events.at(-1)?.reason).toBe('stale_generation');
    const token = active().token;
    receive({ type: 'started', token, generation: 2 }); receive({ type: 'ended', token, generation: 2 });
    broker.enqueue({ ...request(), generation: 2 }); await vi.waitFor(() => expect(host.play).toHaveBeenCalledTimes(3));
  });
  it('stops sound during recording and holds remaining items until recording ends', async () => {
    const { broker, request, host, events } = await setup();
    broker.enqueue(request()); broker.enqueue(request());
    await vi.waitFor(() => expect(host.play).toHaveBeenCalledOnce());
    broker.setPolicy({ recording: true });
    expect(host.stop).toHaveBeenCalledOnce(); expect(events.at(-1)?.reason).toBe('recording');
    broker.setPolicy({ recording: false });
    await vi.waitFor(() => expect(host.play).toHaveBeenCalledTimes(2));
  });
  it('bounds queued items at 20 and never resolves extra assets', async () => {
    const { broker, request, events, resolveAsset } = await setup();
    broker.setPolicy({ recording: true });
    for (let index = 0; index < 21; index++) broker.enqueue(request());
    expect(events.at(-1)?.reason).toBe('queue_full'); expect(resolveAsset).not.toHaveBeenCalled();
    broker.stop(); expect(events.filter((event) => event.state === 'stopped')).toHaveLength(20);
  });
  it('allows only Main-authorized explicit validation assets while speech is disabled', async () => {
    const { broker, request, host, events, asset } = await setup();
    broker.setPolicy({ enabled: false });
    broker.enqueue({ ...request(), manual: true }); expect(events.at(-1)?.reason).toBe('disabled');
    asset.owner = { kind: 'test', id: 'validation-one' };
    broker.enqueue({ ...request(), owner: asset.owner }); expect(events.at(-1)?.reason).toBe('disabled');
    broker.enqueue({ ...request(), owner: asset.owner, manual: true });
    await vi.waitFor(() => expect(host.play).toHaveBeenCalledOnce());
    broker.setPolicy({ enabled: false }); expect(host.stop).not.toHaveBeenCalled();
  });
  it('bounds a stalled ready asset lookup instead of occupying the queue indefinitely', async () => {
    const { broker, request, host, events, resolveAsset } = await setup();
    vi.useFakeTimers(); resolveAsset.mockImplementationOnce(() => new Promise(() => undefined));
    broker.enqueue(request()); await vi.advanceTimersByTimeAsync(15_001);
    expect(events.at(-1)?.reason).toBe('asset_unavailable'); expect(host.play).not.toHaveBeenCalled();
  });
  it('holds while locked, then skips expired items without reading them', async () => {
    const { broker, request, events, resolveAsset, setNow } = await setup();
    broker.setPolicy({ locked: true }); broker.enqueue({ ...request(), expiresAt: 3000 }); setNow(4000);
    broker.setPolicy({ locked: false });
    expect(events.at(-1)?.reason).toBe('expired'); expect(resolveAsset).not.toHaveBeenCalled();
  });
  it('suppresses automatic quiet-hours output while allowing user initiated reading', async () => {
    const { broker, request, events, setNow, host, asset } = await setup();
    const now = Date.parse('2026-10-13T18:00:00Z'); setNow(now); asset.expiresAt = now + 60_000;
    broker.setPolicy({ playback: { volume: 1, muteWhenLocked: true, quietHours: { start: '23:00', end: '08:00', timezone: 'Asia/Shanghai' } } });
    broker.enqueue(request()); expect(events.at(-1)?.reason).toBe('quiet_hours');
    broker.enqueue({ ...request(), manual: true });
    await vi.waitFor(() => expect(host.play).toHaveBeenCalledOnce());
  });
  it.each(['output_device_changed', 'host_crashed', 'autoplay_denied'] as const)('suppresses new automatic output after %s and resumes only a new manual request', async (reason) => {
    const { broker, request, host, events, receive, active } = await setup();
    const first = request(), previouslyQueued = request(), automatic = request(), manual = request();
    broker.enqueue(first); broker.enqueue(previouslyQueued);
    await vi.waitFor(() => expect(host.play).toHaveBeenCalledOnce());
    receive({ type: 'error', token: active().token, generation: 1, reason });
    expect(events.at(-1)?.reason).toBe(reason); expect(host.play).toHaveBeenCalledOnce();
    broker.enqueue(automatic);
    expect(events.at(-1)).toMatchObject({ playbackId: automatic.playbackId, state: 'suppressed', reason });
    expect(host.play).toHaveBeenCalledOnce();
    broker.resumeOutput();
    expect(events.at(-1)).toMatchObject({ playbackId: previouslyQueued.playbackId, state: 'stopped', reason: 'cancelled' });
    expect(host.play).toHaveBeenCalledOnce();
    broker.enqueue({ ...manual, manual: true }); await vi.waitFor(() => expect(host.play).toHaveBeenCalledTimes(2));
    const token = active().token;
    receive({ type: 'started', token, generation: 1 }); receive({ type: 'ended', token, generation: 1 });
    expect(events.filter((event) => event.state === 'played').map((event) => event.playbackId)).toEqual([manual.playbackId]);
  });
  it('keeps a healthy serialized queue intact when an explicit request resumes output', async () => {
    const { broker, request, host, events, ack } = await setup();
    const first = request(), second = request(); broker.enqueue(first); broker.enqueue(second);
    await vi.waitFor(() => expect(host.play).toHaveBeenCalledOnce());
    broker.resumeOutput(); expect(host.play).toHaveBeenCalledOnce();
    expect(events.some((event) => event.state === 'stopped')).toBe(false);
    ack('started'); ack('ended'); await vi.waitFor(() => expect(host.play).toHaveBeenCalledTimes(2));
    ack('started'); ack('ended');
    expect(events.filter((event) => event.state === 'played').map((event) => event.playbackId)).toEqual([first.playbackId, second.playbackId]);
  });
  it('rejects wrong-owner or nonready manifest responses without exposing paths', async () => {
    const { broker, request, host, events, asset } = await setup();
    asset.owner = { kind: 'session', id: 'another-session' }; broker.enqueue(request());
    await vi.waitFor(() => expect(events.at(-1)?.state).toBe('failed'));
    expect(events.at(-1)?.reason).toBe('asset_unavailable'); expect(host.play).not.toHaveBeenCalled();
    expect(JSON.stringify(events)).not.toContain('speech-assets');
  });
  it('checks expiry again after asynchronous resolution', async () => {
    const { broker, request, host, asset, events } = await setup();
    asset.expiresAt = 1000; broker.enqueue(request());
    await vi.waitFor(() => expect(events.at(-1)?.state).toBe('failed')); expect(host.play).not.toHaveBeenCalled();
  });
  it('times out missing ACKs and cannot accept ended after the token expires', async () => {
    const { broker, request, host, events, active, receive, setNow } = await setup();
    broker.enqueue({ ...request(), expiresAt: 2100 });
    await vi.waitFor(() => expect(host.play).toHaveBeenCalledOnce());
    setNow(2200); receive({ type: 'ended', token: active().token, generation: 1 });
    expect(events.some((event) => event.state === 'played')).toBe(false);
    await vi.waitFor(() => expect(events.at(-1)?.reason).toBe('playback_timeout'));
  });
});
describe('ready asset file authorization', () => {
  it('rejects a format and filename mismatch in both directions', async () => {
    const h = await setup(); h.asset.format = 'wav';
    await expect(readAuthorizedPlaybackAsset(h.assetsDirectory, { asset: h.asset, path: h.filename }, h.request(), 2000)).rejects.toThrow('asset_unavailable');
    const filename = h.filename.replace(/\.mp3$/u, '.wav'); await writeFile(filename, h.bytes); h.asset.format = 'mp3';
    await expect(readAuthorizedPlaybackAsset(h.assetsDirectory, { asset: h.asset, path: filename }, h.request(), 2000)).rejects.toThrow('asset_unavailable');
  });
  it('returns bytes only for an exact owner, ready ID and bounded direct MP3 file', async () => {
    const { assetsDirectory, asset, filename, request, bytes } = await setup();
    expect(await readAuthorizedPlaybackAsset(assetsDirectory, { asset, path: filename }, request(), 2000)).toEqual(bytes);
  });
  it('accepts Worker canonical paths when the configured root has a legitimate parent-directory alias', async () => {
    const { assetsDirectory, directory, asset, filename, request, bytes } = await setup();
    const parentAlias = path.join(directory, 'parent-alias'); await symlink(directory, parentAlias);
    const aliasRoot = path.join(parentAlias, path.basename(assetsDirectory));
    const canonicalFilename = await realpath(filename);
    expect(path.dirname(canonicalFilename)).not.toBe(aliasRoot);
    expect(await readAuthorizedPlaybackAsset(aliasRoot, { asset, path: canonicalFilename }, request(), 2000)).toEqual(bytes);
    expect(await readAuthorizedPlaybackAsset(aliasRoot, { asset, path: path.join(aliasRoot, path.basename(filename)) }, request(), 2000)).toEqual(bytes);
  });
  it('rejects a linked cache root even when its target and ready file are otherwise valid', async () => {
    const { assetsDirectory, directory, asset, filename, request } = await setup();
    const linkedRoot = path.join(directory, 'linked-cache'); await symlink(assetsDirectory, linkedRoot);
    await expect(readAuthorizedPlaybackAsset(linkedRoot, { asset, path: await realpath(filename) }, request(), 2000)).rejects.toThrow('asset_unavailable');
  });
  it.each(['outside', 'symlink', 'wrong_size', 'temporary', 'oversized', 'wrong_id'])('rejects %s assets', async (kind) => {
    const { assetsDirectory, directory, asset, filename, request } = await setup();
    let candidate = filename;
    if (kind === 'outside') { candidate = path.join(directory, `${randomUUID()}.mp3`); await writeFile(candidate, new Uint8Array(asset.bytes)); }
    if (kind === 'symlink') { candidate = path.join(assetsDirectory, `${randomUUID()}.mp3`); await symlink(filename, candidate); }
    if (kind === 'temporary') candidate = filename.replace('.mp3', '.part');
    if (kind === 'wrong_size') asset.bytes += 1;
    if (kind === 'oversized') asset.bytes = 8 * 1024 * 1024 + 1;
    if (kind === 'wrong_id') asset.id = randomUUID();
    const input = request(); if (kind === 'wrong_id') input.assetId = randomUUID();
    await expect(readAuthorizedPlaybackAsset(assetsDirectory, { asset, path: candidate }, input, 2000)).rejects.toThrow();
  });
});
