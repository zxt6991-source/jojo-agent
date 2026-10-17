import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { MessageChannelMain } from 'electron';
import { SpeechSettingsSchema, createLocalSpeechSettings, type AudioAsset, type SpeechControl, type SpeechEvent,
  type ScheduleDeliveryControl, type ScheduleDesktopDelivery } from '@desktop-agent/contracts';
import { ElectronAudioHost } from './audio-host';
import { DesktopSpeechHost } from './speech-host';
import { createSilentMp3Fixture } from '../testing/speech-audio-fixture';

vi.mock('./audio-host', () => {
  class Host {
    static instances: Host[] = [];
    receive: (ack: unknown) => void = () => undefined;
    play = vi.fn(async () => undefined); stop = vi.fn(); close = vi.fn();
    constructor() { Host.instances.push(this); }
    onAck(listener: (ack: unknown) => void) { this.receive = listener; return () => { this.receive = () => undefined; }; }
  }
  return { ElectronAudioHost: Host };
});
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class Port extends EventEmitter { start = vi.fn(); postMessage = vi.fn(); close = vi.fn(); }
  class MessageChannelMain {
    static instances: MessageChannelMain[] = [];
    port1 = new Port(); port2 = new Port();
    constructor() { MessageChannelMain.instances.push(this); }
  }
  return { MessageChannelMain, systemPreferences: { getMediaAccessStatus: () => 'granted', askForMediaAccess: async () => true } };
});
const directories: string[] = [], hosts: DesktopSpeechHost[] = [];
afterEach(async () => {
  hosts.splice(0).forEach((host) => host.close());
  vi.useRealTimers();
  (ElectronAudioHost as any).instances.splice(0);
  (MessageChannelMain as any).instances.splice(0);
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function setup(deliveryControl?: (control: ScheduleDeliveryControl) => Promise<boolean>) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'speech-host-')); directories.push(dataDirectory);
  const directory = path.join(dataDirectory, 'runtime', 'speech-assets'); await mkdir(directory, { recursive: true });
  const filename = path.join(directory, `${randomUUID()}.mp3`), bytes = createSilentMp3Fixture(); await writeFile(filename, bytes);
  const settings = SpeechSettingsSchema.parse({ enabled: true, autoReadReplies: true });
  const events: SpeechEvent[] = [];
  const asset: AudioAsset = { id: randomUUID(), owner: { kind: 'session', id: 'session-one' }, bytes: bytes.byteLength,
    format: 'mp3', sampleRate: 24000, createdAt: Date.now(), expiresAt: Date.now() + 60_000 };
  const testAsset: AudioAsset = { ...asset, id: randomUUID(), owner: { kind: 'test', id: 'settings-test' } };
  const scheduleAsset: AudioAsset = { ...asset, id: randomUUID(), owner: { kind: 'schedule', id: 'schedule-one' } };
  const ready = { asset, path: filename }, testReady = { asset: testAsset, path: filename }, scheduleReady = { asset: scheduleAsset, path: filename };
  const session = { setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn() };
  const webContents = { session, getURL: () => 'file:///app/index.html', on: vi.fn(), postMessage: vi.fn() };
  const window = { webContents } as any;
  const worker = { postMessage: vi.fn() } as any;
  const readSettings = vi.fn(async () => settings);
  const request = vi.fn(async (control: SpeechControl): Promise<unknown> => {
    if (control.action === 'readMessage') return ready;
    if (control.action === 'readApproval') return ready;
    if (control.action === 'approvalPending') return true;
    if (control.action === 'previewSchedule') return testReady;
    if (control.action === 'test') return testReady;
    if (control.action === 'resolveAsset') return control.input.assetId === asset.id ? ready
      : control.input.assetId === scheduleAsset.id ? scheduleReady : testReady;
    if (control.action === 'status') return { captures: [], validation: { asr: false, tts: false } };
    return undefined;
  });
  const host = new DesktopSpeechHost({ dataDirectory, buildDirectory: '/test/build', window: () => window, worker: () => worker,
    readSettings, assertSession: async () => undefined, request, emit: (event) => events.push(event), e2e: true,
    ...(deliveryControl ? { deliveryControl } : {}) }); hosts.push(host);
  const audio = (ElectronAudioHost as any).instances.at(-1) as { play: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; receive(ack: unknown): void };
  const input = { sessionId: 'session-one', messageId: 'assistant-one', generation: 0, automatic: false };
  const scheduled: Extract<ScheduleDesktopDelivery, { kind: 'voice' }> = {
    kind: 'voice', identity: { itemId: 'delivery-one', claimToken: 'claim-one', playbackId: 'playback-one', generation: 2 },
    scheduleId: 'schedule-one', scheduleRunId: 'run-one', assetId: scheduleAsset.id,
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  return { host, audio, request, events, settings, readSettings, asset, ready, testReady, input, window, worker, scheduled };
}
function defer<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

it('allows explicit local microphone validation while keeping disabled conversations gated', async () => {
  const { host, readSettings } = await setup();
  readSettings.mockResolvedValue(createLocalSpeechSettings());
  const handle = await host.begin({ generation: 1, purpose: 'validation' });
  expect(handle.captureId).toBeTruthy();
  await host.cancel(handle);
  await expect(host.begin({ generation: 2, purpose: 'conversation' })).rejects.toThrow('请先测试并启用语音');
});

it('waits for the Worker durable start permission before scheduled audio can play and completes only on actual ended', async () => {
  const permission = defer<boolean>(), control = vi.fn(async () => permission.promise);
  const { host, audio, scheduled } = await setup(control);
  let settled = false;
  const operation = host.playScheduled(scheduled).then(result => { settled = true; return result; });
  await vi.waitFor(() => expect(control).toHaveBeenCalledWith({ action: 'start', identity: scheduled.identity }));
  expect(audio.play).not.toHaveBeenCalled(); expect(settled).toBe(false);
  permission.resolve(true);
  await vi.waitFor(() => expect(audio.play).toHaveBeenCalledOnce());
  expect(settled).toBe(false);
  const current = audio.play.mock.calls[0]![0];
  audio.receive({ type: 'ended', token: current.token, generation: current.generation });
  await Promise.resolve(); expect(settled).toBe(false);
  audio.receive({ type: 'started', token: current.token, generation: current.generation });
  await Promise.resolve(); expect(settled).toBe(false);
  audio.receive({ type: 'ended', token: current.token, generation: current.generation });
  await expect(operation).resolves.toEqual({ identity: scheduled.identity, state: 'played' });
});

it.each(['denied', 'Worker unavailable'] as const)('does not emit sound when scheduled start permission is %s', async reason => {
  const control = vi.fn(async () => { if (reason === 'Worker unavailable') throw new Error('Worker exited'); return false; });
  const { host, audio, scheduled } = await setup(control);
  const operation = host.playScheduled(scheduled);
  await expect(operation).resolves.toMatchObject({ identity: scheduled.identity, state: 'uncertain' });
  expect(control).toHaveBeenCalledWith({ action: 'start', identity: scheduled.identity });
  expect(audio.play).not.toHaveBeenCalled();
});

it('cancels a scheduled request while its durable permission is pending and rejects a late permission', async () => {
  const permission = defer<boolean>(), control = vi.fn(async () => permission.promise);
  const { host, audio, scheduled } = await setup(control);
  const operation = host.playScheduled(scheduled);
  await vi.waitFor(() => expect(control).toHaveBeenCalledWith({ action: 'start', identity: scheduled.identity }));
  host.cancelScheduled(scheduled.identity);
  await expect(operation).resolves.toMatchObject({ identity: scheduled.identity, state: 'interrupted' });
  permission.resolve(true); await Promise.resolve(); await Promise.resolve();
  expect(audio.play).not.toHaveBeenCalled();
});

it('does not let an old claim cancel a new scheduled identity', async () => {
  const permission = defer<boolean>(), control = vi.fn(async () => permission.promise);
  const { host, audio, scheduled } = await setup(control);
  const operation = host.playScheduled(scheduled);
  await vi.waitFor(() => expect(control).toHaveBeenCalledWith({ action: 'start', identity: scheduled.identity }));
  host.cancelScheduled({ ...scheduled.identity, claimToken: 'stale-claim' });
  permission.resolve(true); await vi.waitFor(() => expect(audio.play).toHaveBeenCalledOnce());
  const current = audio.play.mock.calls[0]![0];
  audio.receive({ type: 'started', token: current.token, generation: current.generation });
  audio.receive({ type: 'ended', token: current.token, generation: current.generation });
  await expect(operation).resolves.toMatchObject({ state: 'played' });
});

it.each(['rejected', 'RPC failed'] as const)('stops scheduled sound immediately when its renewal is %s and ignores a late ended ACK', async reason => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const control = vi.fn(async (input: ScheduleDeliveryControl) => {
    if (input.action === 'start') return true;
    if (reason === 'RPC failed') throw new Error('Worker unavailable');
    return false;
  });
  const { host, audio, scheduled } = await setup(control);
  const operation = host.playScheduled(scheduled);
  await vi.waitFor(() => expect(audio.play).toHaveBeenCalledOnce());
  const current = audio.play.mock.calls[0]![0];
  audio.receive({ type: 'started', token: current.token, generation: current.generation });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(control).toHaveBeenCalledWith({ action: 'renew', identity: scheduled.identity });
  expect(audio.stop).toHaveBeenCalledWith(current.token);
  await expect(operation).resolves.toMatchObject({ identity: scheduled.identity, state: 'uncertain', errorCode: 'delivery_claim_lost' });
  audio.receive({ type: 'ended', token: current.token, generation: current.generation });
  expect((await host.status()).playbacks.find(state => state.playbackId === scheduled.identity.playbackId)?.state).toBe('interrupted');
});

it('cancels a scheduled request during asynchronous configuration before it can reach the start handshake', async () => {
  const control = vi.fn(async () => true);
  const { host, audio, scheduled, readSettings, settings } = await setup(control);
  const pending = defer<typeof settings>(); readSettings.mockReturnValueOnce(pending.promise);
  const operation = host.playScheduled(scheduled);
  await vi.waitFor(() => expect(readSettings).toHaveBeenCalledOnce());
  host.cancelScheduled(scheduled.identity); pending.resolve(settings);
  await expect(operation).resolves.toMatchObject({ identity: scheduled.identity, state: 'interrupted' });
  expect(control).not.toHaveBeenCalled(); expect(audio.play).not.toHaveBeenCalled();
});

it('rejects a duplicate scheduled playback while configuration is pending without replacing its original completion', async () => {
  const control = vi.fn(async () => true);
  const { host, audio, scheduled, readSettings, settings } = await setup(control);
  const pending = defer<typeof settings>(); readSettings.mockReturnValueOnce(pending.promise);
  const operation = host.playScheduled(scheduled);
  await vi.waitFor(() => expect(readSettings).toHaveBeenCalledOnce());
  await expect(host.playScheduled(scheduled)).resolves.toMatchObject({ identity: scheduled.identity, state: 'uncertain' });
  expect(control).not.toHaveBeenCalled(); expect(audio.play).not.toHaveBeenCalled();
  pending.resolve(settings);
  await vi.waitFor(() => expect(audio.play).toHaveBeenCalledOnce());
  const current = audio.play.mock.calls[0]![0];
  audio.receive({ type: 'started', token: current.token, generation: current.generation });
  audio.receive({ type: 'ended', token: current.token, generation: current.generation });
  await expect(operation).resolves.toMatchObject({ identity: scheduled.identity, state: 'played' });
});

it('ignores a renewal response for a finished claim when the same playback id now belongs to another claim', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const renewal = defer<boolean>();
  const control = vi.fn(async (input: ScheduleDeliveryControl) => input.action === 'renew' ? renewal.promise : true);
  const { host, audio, scheduled } = await setup(control);
  const firstOperation = host.playScheduled(scheduled);
  await vi.waitFor(() => expect(audio.play).toHaveBeenCalledOnce());
  const first = audio.play.mock.calls[0]![0];
  audio.receive({ type: 'started', token: first.token, generation: first.generation });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(control).toHaveBeenCalledWith({ action: 'renew', identity: scheduled.identity });
  audio.receive({ type: 'ended', token: first.token, generation: first.generation });
  await expect(firstOperation).resolves.toMatchObject({ state: 'played' });
  const newer = { ...scheduled, identity: { ...scheduled.identity, claimToken: 'claim-new', generation: 3 } };
  const nextOperation = host.playScheduled(newer);
  await vi.waitFor(() => expect(audio.play).toHaveBeenCalledTimes(2));
  const next = audio.play.mock.calls[1]![0];
  audio.receive({ type: 'started', token: next.token, generation: next.generation });
  renewal.resolve(false); await vi.advanceTimersByTimeAsync(0);
  expect(audio.stop).not.toHaveBeenCalledWith(next.token);
  audio.receive({ type: 'ended', token: next.token, generation: next.generation });
  await expect(nextOperation).resolves.toMatchObject({ identity: newer.identity, state: 'played' });
});

it('keeps a newer pending claim when a cancelled configuration request with the same playback id settles late', async () => {
  const control = vi.fn(async () => true);
  const { host, audio, scheduled, readSettings, settings } = await setup(control);
  const previousSettings = defer<typeof settings>(), nextSettings = defer<typeof settings>();
  readSettings.mockReturnValueOnce(previousSettings.promise).mockReturnValueOnce(nextSettings.promise);
  const previous = host.playScheduled(scheduled);
  await vi.waitFor(() => expect(readSettings).toHaveBeenCalledOnce());
  host.cancelScheduled(scheduled.identity);
  const newer = { ...scheduled, identity: { ...scheduled.identity, claimToken: 'claim-newer', generation: 3 } };
  const nextOperation = host.playScheduled(newer);
  await vi.waitFor(() => expect(readSettings).toHaveBeenCalledTimes(2));
  previousSettings.resolve(settings);
  await expect(previous).resolves.toMatchObject({ identity: scheduled.identity, state: 'interrupted' });
  nextSettings.resolve(settings);
  await vi.waitFor(() => expect(audio.play).toHaveBeenCalledOnce());
  expect(control).toHaveBeenCalledWith({ action: 'start', identity: newer.identity });
  expect(control).not.toHaveBeenCalledWith({ action: 'start', identity: scheduled.identity });
  const current = audio.play.mock.calls[0]![0];
  audio.receive({ type: 'started', token: current.token, generation: current.generation });
  audio.receive({ type: 'ended', token: current.token, generation: current.generation });
  await expect(nextOperation).resolves.toMatchObject({ identity: newer.identity, state: 'played' });
});

it('serializes distinct runs of the same schedule without cancelling an earlier occurrence', async () => {
  const control = vi.fn(async () => true);
  const { host, audio, scheduled, events } = await setup(control);
  const firstOperation = host.playScheduled(scheduled);
  await vi.waitFor(() => expect(audio.play).toHaveBeenCalledOnce());
  const first = audio.play.mock.calls[0]![0];
  audio.receive({ type: 'started', token: first.token, generation: first.generation });
  const nextRequest = { ...scheduled, scheduleRunId: 'run-two', identity: {
    itemId: 'delivery-two', claimToken: 'claim-two', playbackId: 'playback-two', generation: 1
  } };
  const nextOperation = host.playScheduled(nextRequest);
  await vi.waitFor(() => expect(events).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'playback', playbackId: 'playback-two', state: 'queued' })
  ])));
  expect(audio.play).toHaveBeenCalledOnce(); expect(audio.stop).not.toHaveBeenCalled();
  expect(control).not.toHaveBeenCalledWith({ action: 'start', identity: nextRequest.identity });
  audio.receive({ type: 'ended', token: first.token, generation: first.generation });
  await expect(firstOperation).resolves.toMatchObject({ identity: scheduled.identity, state: 'played' });
  await vi.waitFor(() => expect(audio.play).toHaveBeenCalledTimes(2));
  const second = audio.play.mock.calls[1]![0];
  expect(second.token).not.toBe(first.token);
  audio.receive({ type: 'started', token: second.token, generation: second.generation });
  audio.receive({ type: 'ended', token: second.token, generation: second.generation });
  await expect(nextOperation).resolves.toMatchObject({ identity: nextRequest.identity, state: 'played' });
});

it('suppresses an automatic reminder during quiet hours but permits only an explicitly authorized replay', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-14T23:30:00.000Z');
  const control = vi.fn(async () => true);
  const { host, audio, scheduled, settings } = await setup(control);
  settings.playback.quietHours = { start: '22:00', end: '08:00', timezone: 'UTC' };
  await expect(host.playScheduled(scheduled)).resolves.toMatchObject({ state: 'suppressed', errorCode: 'quiet_hours' });
  expect(control).not.toHaveBeenCalled(); expect(audio.play).not.toHaveBeenCalled();
  const replay = { ...scheduled, identity: { ...scheduled.identity, claimToken: 'claim-replay', playbackId: 'playback-replay', generation: 3 } };
  host.authorizeReplay(replay.identity.itemId);
  const operation = host.playScheduled(replay);
  await vi.waitFor(() => expect(audio.play).toHaveBeenCalledOnce());
  const current = audio.play.mock.calls[0]![0];
  audio.receive({ type: 'started', token: current.token, generation: current.generation });
  audio.receive({ type: 'ended', token: current.token, generation: current.generation });
  await expect(operation).resolves.toMatchObject({ identity: replay.identity, state: 'played' });
});

it('keeps even a manual reminder replay silent while locked and grants start only after unlocking', async () => {
  const control = vi.fn(async () => true);
  const { host, audio, scheduled, events } = await setup(control);
  host.lockedState(true); host.authorizeReplay(scheduled.identity.itemId);
  const operation = host.playScheduled(scheduled);
  await vi.waitFor(() => expect(events).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'playback', playbackId: scheduled.identity.playbackId, state: 'queued' })
  ])));
  expect(control).not.toHaveBeenCalled(); expect(audio.play).not.toHaveBeenCalled();
  host.lockedState(false);
  await vi.waitFor(() => expect(audio.play).toHaveBeenCalledOnce());
  const current = audio.play.mock.calls[0]![0];
  audio.receive({ type: 'started', token: current.token, generation: current.generation });
  audio.receive({ type: 'ended', token: current.token, generation: current.generation });
  await expect(operation).resolves.toMatchObject({ identity: scheduled.identity, state: 'played' });
});

it('maps actual playback ACKs to public session/message identity without exposing bytes or paths', async () => {
  const { host, audio, events, input } = await setup();
  const result = await host.read(input); await vi.waitFor(() => expect(audio.play).toHaveBeenCalledOnce());
  const current = audio.play.mock.calls[0]![0];
  audio.receive({ type: 'started', token: current.token, generation: current.generation });
  audio.receive({ type: 'ended', token: current.token, generation: current.generation });
  const playback = events.filter((event) => event.type === 'playback');
  expect(playback.map((event) => event.state)).toEqual(['preparing', 'queued', 'playing', 'played']);
  expect(playback.every((event) => event.generation === input.generation && event.sessionId === input.sessionId && event.messageId === input.messageId)).toBe(true);
  expect(result.generation).toBe(0); expect(JSON.stringify(events)).not.toContain('speech-assets');
  expect(playback.at(-1)?.playbackId).toBe(result.playbackId);
});
it('allows a new request after stopping a session, even when UI generation restarted at zero', async () => {
  const { host, audio, input } = await setup();
  await host.read({ ...input, generation: 9 }); await vi.waitFor(() => expect(audio.play).toHaveBeenCalledOnce());
  host.stop({ sessionId: input.sessionId });
  await host.read(input); await vi.waitFor(() => expect(audio.play).toHaveBeenCalledTimes(2));
});
it('blocks a session asset returned for another conversation before enqueue', async () => {
  const { host, audio, ready, asset, input, request } = await setup();
  request.mockImplementation(async (control) => control.action === 'readMessage'
    ? { ...ready, asset: { ...asset, owner: { kind: 'session', id: 'other-session' } } } : undefined);
  await expect(host.read(input)).rejects.toThrow(); expect(audio.play).not.toHaveBeenCalled();
});
it('allows explicit settings试听 while disabled but requires a dedicated test-owned asset', async () => {
  const { host, audio, settings } = await setup(); settings.enabled = false;
  await host.test({ generation: 0 }); await vi.waitFor(() => expect(audio.play).toHaveBeenCalledOnce());
});
it('retains continuation offsets on the public result and actual played event without automatically queuing the next segment', async () => {
  const { host, audio, ready, request, input, events } = await setup();
  const fallback = request.getMockImplementation()!;
  request.mockImplementation(async control => control.action === 'readMessage' ? { ...ready, nextOffset: 600 } : fallback(control));
  const result = await host.read(input); expect(result.nextOffset).toBe(600);
  await vi.waitFor(() => expect(audio.play).toHaveBeenCalledOnce());
  const current = audio.play.mock.calls[0]![0];
  audio.receive({ type: 'started', token: current.token, generation: current.generation });
  audio.receive({ type: 'ended', token: current.token, generation: current.generation });
  expect(events.at(-1)).toMatchObject({ type: 'playback', state: 'played', nextOffset: 600, messageId: input.messageId });
  expect(request.mock.calls.filter(([control]) => control.action === 'readMessage')).toHaveLength(1);
});
it('deduplicates repeated approval snapshots and rechecks the pending record immediately before playback', async () => {
  const { host, audio, request, input } = await setup();
  const approval = { sessionId: input.sessionId, approvalId: 'approval-one', generation: 1 };
  const a = host.readApproval(approval), b = host.readApproval({ ...approval, generation: 2 });
  expect(a).toBe(b); expect(await a).toEqual(await b);
  await vi.waitFor(() => expect(audio.play).toHaveBeenCalledOnce());
  expect(request.mock.calls.filter(([control]) => control.action === 'readApproval')).toHaveLength(1);
  expect(request.mock.calls.filter(([control]) => control.action === 'approvalPending')).toHaveLength(2);
});
it('refuses approval audio if the record resolves while its asset is being prepared', async () => {
  const { host, audio, ready, request, input } = await setup();
  const fallback = request.getMockImplementation()!; let pendingChecks = 0;
  request.mockImplementation(async control => control.action === 'approvalPending' ? ++pendingChecks === 1
    : control.action === 'readApproval' ? ready : fallback(control));
  await host.readApproval({ sessionId: input.sessionId, approvalId: 'approval-one', generation: 1 });
  await vi.waitFor(async () => expect((await host.status()).playbacks.at(-1)?.state).toBe('failed'));
  expect(audio.play).not.toHaveBeenCalled();
});
it('requires automatic-reading opt-in for approval prompts before requesting synthesis', async () => {
  const { host, audio, request, settings, input } = await setup(); settings.autoReadReplies = false;
  await expect(host.readApproval({ sessionId: input.sessionId, approvalId: 'approval-one', generation: 1 })).rejects.toThrow('自动朗读已关闭');
  expect(request.mock.calls.filter(([control]) => control.action === 'readApproval')).toHaveLength(0); expect(audio.play).not.toHaveBeenCalled();
});
it('fences a pending approval prompt on a conversation stop before the synthesized asset returns', async () => {
  const { host, audio, ready, request, input } = await setup();
  const pending = defer<typeof ready>(), fallback = request.getMockImplementation()!;
  request.mockImplementation(async control => control.action === 'readApproval' ? pending.promise : fallback(control));
  const operation = host.readApproval({ sessionId: input.sessionId, approvalId: 'approval-one', generation: 1 });
  await vi.waitFor(() => expect(request.mock.calls.some(([control]) => control.action === 'readApproval')).toBe(true));
  host.stop({ sessionId: input.sessionId }); pending.resolve(ready);
  await expect(operation).rejects.toThrow('审批朗读已停止'); expect(audio.play).not.toHaveBeenCalled();
});
it.each(['reply', 'approval'] as const)('invalidates a pending automatic %s even if automatic reading is enabled again before synthesis returns', async kind => {
  const { host, audio, ready, request, input, settings, readSettings } = await setup();
  await host.configure(settings);
  const pending = defer<typeof ready>(), fallback = request.getMockImplementation()!;
  request.mockImplementation(async control => control.action === (kind === 'reply' ? 'readMessage' : 'readApproval') ? pending.promise : fallback(control));
  const operation = kind === 'reply' ? host.read({ ...input, automatic: true })
    : host.readApproval({ sessionId: input.sessionId, approvalId: 'approval-one', generation: input.generation });
  const rejection = expect(operation).rejects.toThrow('朗读已停止');
  await vi.waitFor(() => expect(request.mock.calls.some(([control]) => control.action === (kind === 'reply' ? 'readMessage' : 'readApproval'))).toBe(true));
  const disabled = { ...settings, autoReadReplies: false }; readSettings.mockResolvedValue(disabled);
  await host.configure(disabled);
  expect(request).toHaveBeenCalledWith({ action: 'stopRead', sessionId: input.sessionId, generation: input.generation });
  expect((await host.status()).playbacks.at(-1)?.state).toBe('interrupted');
  readSettings.mockResolvedValue(settings); await host.configure(settings);
  pending.resolve(ready); await rejection; expect(audio.play).not.toHaveBeenCalled();
});
it.each(['reply', 'approval'] as const)('rejects a new automatic %s when consent is revoked during its initial settings read', async kind => {
  const { host, audio, request, input, settings, readSettings } = await setup();
  const pending = defer<typeof settings>(); readSettings.mockReturnValueOnce(pending.promise);
  const operation = kind === 'reply' ? host.read({ ...input, automatic: true })
    : host.readApproval({ sessionId: input.sessionId, approvalId: 'approval-one', generation: input.generation });
  const rejection = expect(operation).rejects.toThrow('自动朗读已关闭');
  await vi.waitFor(() => expect(readSettings).toHaveBeenCalledOnce());
  await host.configure({ ...settings, autoReadReplies: false }); pending.resolve(settings); await rejection;
  expect(request.mock.calls.some(([control]) => control.action === 'readMessage' || control.action === 'readApproval')).toBe(false);
  expect(audio.play).not.toHaveBeenCalled();
});
it('rechecks automatic reply consent after synthesis and delayed configuration before enqueue', async () => {
  const { host, audio, input, settings, readSettings } = await setup();
  await host.configure(settings);
  const pending = defer<typeof settings>(); readSettings.mockResolvedValueOnce(settings).mockReturnValueOnce(pending.promise);
  const operation = host.read({ ...input, automatic: true }); const rejection = expect(operation).rejects.toThrow('朗读已停止');
  await vi.waitFor(() => expect(readSettings).toHaveBeenCalledTimes(2));
  const disabled = { ...settings, autoReadReplies: false }; readSettings.mockResolvedValue(disabled);
  await host.configure(disabled); pending.resolve(settings);
  await rejection; expect(audio.play).not.toHaveBeenCalled();
});
it.each(['reply', 'approval'] as const)('removes a queued automatic %s without interrupting an independent scheduled voice', async kind => {
  const { host, audio, input, settings, readSettings, scheduled, events } = await setup(async () => true);
  const delivery = host.playScheduled(scheduled);
  await vi.waitFor(() => expect(audio.play).toHaveBeenCalledOnce());
  const scheduledOutput = audio.play.mock.calls[0]![0];
  const automatic = kind === 'reply' ? await host.read({ ...input, automatic: true })
    : await host.readApproval({ sessionId: input.sessionId, approvalId: 'approval-one', generation: input.generation });
  expect(events.filter(event => event.type === 'playback' && event.playbackId === automatic.playbackId).at(-1)).toMatchObject({ state: 'queued' });
  const disabled = { ...settings, autoReadReplies: false }; readSettings.mockResolvedValue(disabled); await host.configure(disabled);
  expect(events.filter(event => event.type === 'playback' && event.playbackId === automatic.playbackId).at(-1)).toMatchObject({ state: 'interrupted' });
  expect(audio.stop).not.toHaveBeenCalled();
  audio.receive({ type: 'started', token: scheduledOutput.token, generation: scheduledOutput.generation });
  audio.receive({ type: 'ended', token: scheduledOutput.token, generation: scheduledOutput.generation });
  await expect(delivery).resolves.toMatchObject({ state: 'played' });
  await new Promise(resolve => setImmediate(resolve)); expect(audio.play).toHaveBeenCalledOnce();
});
it.each(['reply', 'approval'] as const)('rechecks persisted consent immediately before a queued automatic %s can play', async kind => {
  const { host, audio, input, settings, readSettings, scheduled } = await setup(async () => true);
  const delivery = host.playScheduled(scheduled); await vi.waitFor(() => expect(audio.play).toHaveBeenCalledOnce());
  const output = audio.play.mock.calls[0]![0];
  const automatic = kind === 'reply' ? await host.read({ ...input, automatic: true })
    : await host.readApproval({ sessionId: input.sessionId, approvalId: 'approval-one', generation: input.generation });
  // The saved preference can change before its configuration push reaches Main.
  readSettings.mockResolvedValue({ ...settings, autoReadReplies: false });
  audio.receive({ type: 'started', token: output.token, generation: output.generation });
  audio.receive({ type: 'ended', token: output.token, generation: output.generation });
  await expect(delivery).resolves.toMatchObject({ state: 'played' });
  await vi.waitFor(async () => expect((await host.status()).playbacks.find(value => value.playbackId === automatic.playbackId)?.state).toBe('interrupted'));
  expect(audio.play).toHaveBeenCalledOnce();
});
it.each(['reply', 'approval'] as const)('stops a playing automatic %s while keeping subsequent manual reading available', async kind => {
  const { host, audio, input, settings, readSettings, events } = await setup();
  const automatic = kind === 'reply' ? await host.read({ ...input, automatic: true })
    : await host.readApproval({ sessionId: input.sessionId, approvalId: 'approval-one', generation: input.generation });
  await vi.waitFor(() => expect(audio.play).toHaveBeenCalledOnce());
  const output = audio.play.mock.calls[0]![0]; audio.receive({ type: 'started', token: output.token, generation: output.generation });
  const disabled = { ...settings, autoReadReplies: false }; readSettings.mockResolvedValue(disabled); await host.configure(disabled);
  expect(audio.stop).toHaveBeenCalledWith(output.token);
  expect(events.filter(event => event.type === 'playback' && event.playbackId === automatic.playbackId).at(-1)).toMatchObject({ state: 'interrupted' });
  await host.read({ ...input, generation: input.generation + 1, automatic: false });
  await vi.waitFor(() => expect(audio.play).toHaveBeenCalledTimes(2));
});
it.each(['reply', 'approval'] as const)('fences an automatic %s while the broker is resolving its asset before playback', async kind => {
  const { host, audio, ready, request, input, settings, readSettings } = await setup();
  const pending = defer<typeof ready>(), fallback = request.getMockImplementation()!;
  request.mockImplementation(async control => control.action === 'resolveAsset' ? pending.promise : fallback(control));
  if (kind === 'reply') await host.read({ ...input, automatic: true });
  else await host.readApproval({ sessionId: input.sessionId, approvalId: 'approval-one', generation: input.generation });
  await vi.waitFor(() => expect(request.mock.calls.some(([control]) => control.action === 'resolveAsset')).toBe(true));
  const disabled = { ...settings, autoReadReplies: false }; readSettings.mockResolvedValue(disabled); await host.configure(disabled);
  pending.resolve(ready); await new Promise(resolve => setImmediate(resolve)); expect(audio.play).not.toHaveBeenCalled();
});
it('keeps a newer manual synthesis even if its UI generation is lower than an old automatic request', async () => {
  const { host, audio, ready, request, input, settings, readSettings } = await setup();
  const pendingAutomatic = defer<typeof ready>(), pendingManual = defer<typeof ready>(), fallback = request.getMockImplementation()!;
  request.mockImplementation(async control => control.action === 'readMessage'
    ? control.input.automatic ? pendingAutomatic.promise : pendingManual.promise : fallback(control));
  const automatic = host.read({ ...input, automatic: true, generation: 100 });
  const rejected = expect(automatic).rejects.toThrow('朗读已停止');
  await vi.waitFor(() => expect(request.mock.calls.filter(([control]) => control.action === 'readMessage')).toHaveLength(1));
  const manual = host.read({ ...input, automatic: false, generation: 0 });
  await vi.waitFor(() => expect(request.mock.calls.filter(([control]) => control.action === 'readMessage')).toHaveLength(2));
  const disabled = { ...settings, autoReadReplies: false }; readSettings.mockResolvedValue(disabled); await host.configure(disabled);
  expect(request.mock.calls.filter(([control]) => control.action === 'stopRead')).toHaveLength(0);
  pendingAutomatic.resolve(ready); await rejected;
  pendingManual.resolve(ready); await manual; await vi.waitFor(() => expect(audio.play).toHaveBeenCalledOnce());
});
it('preserves active manual reading and its queued scheduled voice when automatic reading is disabled', async () => {
  const { host, audio, input, settings, readSettings, scheduled } = await setup(async () => true);
  await host.read(input); await vi.waitFor(() => expect(audio.play).toHaveBeenCalledOnce());
  const manualOutput = audio.play.mock.calls[0]![0];
  const delivery = host.playScheduled(scheduled);
  await vi.waitFor(async () => expect((await host.status()).playbacks.some(value => value.playbackId === scheduled.identity.playbackId && value.state === 'queued')).toBe(true));
  const disabled = { ...settings, autoReadReplies: false }; readSettings.mockResolvedValue(disabled); await host.configure(disabled);
  expect(audio.stop).not.toHaveBeenCalled();
  audio.receive({ type: 'started', token: manualOutput.token, generation: manualOutput.generation });
  audio.receive({ type: 'ended', token: manualOutput.token, generation: manualOutput.generation });
  await vi.waitFor(() => expect(audio.play).toHaveBeenCalledTimes(2));
  const scheduledOutput = audio.play.mock.calls[1]![0];
  audio.receive({ type: 'started', token: scheduledOutput.token, generation: scheduledOutput.generation });
  audio.receive({ type: 'ended', token: scheduledOutput.token, generation: scheduledOutput.generation });
  await expect(delivery).resolves.toMatchObject({ state: 'played' }); expect(audio.stop).not.toHaveBeenCalled();
});
it('requires enabled speech and a test-owned asset for saved reminder previews', async () => {
  const { host, audio, settings, request } = await setup(); settings.enabled = false;
  await expect(host.previewSchedule({ scheduleId: 'schedule-one', generation: 1 })).rejects.toThrow('启用语音');
  expect(request.mock.calls.some(([control]) => control.action === 'previewSchedule')).toBe(false);
  settings.enabled = true; await host.previewSchedule({ scheduleId: 'schedule-one', generation: 2 });
  await vi.waitFor(() => expect(audio.play).toHaveBeenCalledOnce());
});
it('clearing the speech cache cancels delayed synthesis and active playback before asking Worker to delete assets', async () => {
  const { host, audio, ready, request, input } = await setup();
  const pending = defer<typeof ready>(), fallback = request.getMockImplementation()!;
  request.mockImplementation(async control => control.action === 'readMessage' ? pending.promise : fallback(control));
  const operation = host.read(input);
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith({ action: 'readMessage', input }));
  await host.clearCache(); expect(request).toHaveBeenCalledWith({ action: 'clearCache' });
  pending.resolve(ready); await expect(operation).rejects.toThrow('朗读已停止'); expect(audio.play).not.toHaveBeenCalled();
});
it('rejects a conversation-owned asset returned to the settings test', async () => {
  const { host, audio, ready, request } = await setup();
  request.mockImplementation(async (control) => control.action === 'test' ? ready : undefined);
  await expect(host.test({ generation: 0 })).rejects.toThrow(); expect(audio.play).not.toHaveBeenCalled();
});
it('fences a late synthesis after global stop and stores its terminal state in status', async () => {
  const { host, audio, ready, request, input } = await setup();
  const pending = defer<typeof ready>();
  request.mockImplementation(async (control) => control.action === 'readMessage' ? pending.promise
    : control.action === 'status' ? { captures: [], validation: { asr: false, tts: false } } : undefined);
  const operation = host.read(input);
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith({ action: 'readMessage', input }));
  host.stop({}); pending.resolve(ready);
  await expect(operation).rejects.toThrow(); expect(audio.play).not.toHaveBeenCalled();
  expect((await host.status()).playbacks[0]?.state).toMatch(/^(failed|interrupted)$/u);
});
it('fences settings试听 when stopped while synthesis is pending', async () => {
  const { host, audio, testReady, request } = await setup();
  const pending = defer<typeof testReady>(); request.mockImplementation(async (control) => control.action === 'test' ? pending.promise : undefined);
  const operation = host.test({ generation: 0 }); host.stop({}); pending.resolve(testReady);
  await expect(operation).rejects.toThrow(); expect(audio.play).not.toHaveBeenCalled();
});
it('fences a pending朗读 on suspend rather than playing its result after wake', async () => {
  const { host, audio, ready, request, input } = await setup();
  const pending = defer<typeof ready>(); request.mockImplementation(async (control) => control.action === 'readMessage' ? pending.promise : undefined);
  const operation = host.read(input);
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith({ action: 'readMessage', input }));
  host.suspend(); pending.resolve(ready);
  await expect(operation).rejects.toThrow(); expect(audio.play).not.toHaveBeenCalled();
});
it('cancels Worker synthesis when closing the Main host and makes repeated close idempotent', async () => {
  const { host, audio, ready, request, input } = await setup();
  const pending = defer<typeof ready>();
  request.mockImplementation(async (control) => control.action === 'readMessage' ? pending.promise : undefined);
  const operation = host.read(input);
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith({ action: 'readMessage', input }));
  host.close(); host.close();
  expect(request.mock.calls.filter(([control]) => control.action === 'stopRead')).toHaveLength(1);
  expect(request).toHaveBeenCalledWith({ action: 'stopRead' });
  pending.resolve(ready); await expect(operation).rejects.toThrow(); expect(audio.play).not.toHaveBeenCalled();
});
it('refuses recording while locked, without creating an audio port', async () => {
  const { host, worker } = await setup(); host.lockedState(true);
  await expect(host.begin({ purpose: 'conversation', sessionId: 'session-one', generation: 0 })).rejects.toThrow();
  expect(worker.postMessage).not.toHaveBeenCalled();
});
it('fences a delayed begin when the device locks before permissions complete', async () => {
  const { host, worker, readSettings, settings } = await setup();
  const pending = defer<typeof settings>(); readSettings.mockReturnValue(pending.promise);
  const operation = host.begin({ purpose: 'conversation', sessionId: 'session-one', generation: 0 });
  host.lockedState(true); pending.resolve(settings);
  await expect(operation).rejects.toThrow(); expect(worker.postMessage).not.toHaveBeenCalled();
});
it.each(['lock', 'suspend', 'close', 'cancel_all'] as const)('closes both untransferred channel endpoints when %s cancels begin during configuration', async (action) => {
  const { host, worker } = await setup();
  const pending = defer<void>();
  const configure = vi.spyOn(host, 'configure').mockReturnValueOnce(pending.promise);
  const operation = host.begin({ purpose: 'conversation', sessionId: 'session-one', generation: 0 });
  await vi.waitFor(() => expect(configure).toHaveBeenCalledOnce());
  const channels = [...(MessageChannelMain as any).instances] as { port1: { close: ReturnType<typeof vi.fn> }; port2: { close: ReturnType<typeof vi.fn> } }[];
  expect(channels).toHaveLength(2);
  if (action === 'lock') host.lockedState(true);
  else if (action === 'suspend') host.suspend();
  else if (action === 'close') host.close();
  else (host as any).cancelAll();
  pending.resolve(); await expect(operation).rejects.toThrow('录音已取消');
  expect(worker.postMessage).not.toHaveBeenCalled();
  for (const channel of channels) { expect(channel.port1.close).toHaveBeenCalledOnce(); expect(channel.port2.close).toHaveBeenCalledOnce(); }
});
it('closes untransferred channel endpoints if sending the Worker port fails', async () => {
  const { host, worker } = await setup(); worker.postMessage.mockImplementation(() => { throw new Error('Worker exited'); });
  await expect(host.begin({ purpose: 'conversation', sessionId: 'session-one', generation: 0 })).rejects.toThrow('Worker exited');
  const channels = [...(MessageChannelMain as any).instances] as { port1: { close: ReturnType<typeof vi.fn> }; port2: { close: ReturnType<typeof vi.fn> } }[];
  expect(channels).toHaveLength(2);
  for (const channel of channels) { expect(channel.port1.close).toHaveBeenCalledOnce(); expect(channel.port2.close).toHaveBeenCalledOnce(); }
});
it('fences朗读 again after asynchronous configuration just before enqueue', async () => {
  const { host, audio, readSettings, settings, input } = await setup();
  const pending = defer<typeof settings>(); readSettings.mockResolvedValueOnce(settings).mockReturnValueOnce(pending.promise);
  const operation = host.read(input);
  await vi.waitFor(() => expect(readSettings).toHaveBeenCalledTimes(2));
  host.stop({ sessionId: input.sessionId }); pending.resolve(settings);
  await expect(operation).rejects.toThrow(); expect(audio.play).not.toHaveBeenCalled();
});
it('fences settings试听 again after settings are read just before enqueue', async () => {
  const { host, audio, readSettings, settings } = await setup();
  const pending = defer<typeof settings>(); readSettings.mockReturnValueOnce(pending.promise);
  const operation = host.test({ generation: 0 });
  await vi.waitFor(() => expect(readSettings).toHaveBeenCalledOnce());
  host.stop({}); pending.resolve(settings);
  await expect(operation).rejects.toThrow(); expect(audio.play).not.toHaveBeenCalled();
});
it('invalidates the capture and delayed朗读 when the Main frame reloads', async () => {
  const { host, window, request, ready, input, audio } = await setup(); host.installPermissions(window);
  const capture = await host.begin({ purpose: 'validation', generation: 0 });
  const pending = defer<typeof ready>();
  request.mockImplementation(async (control) => control.action === 'readMessage' ? pending.promise : undefined);
  const operation = host.read(input);
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith({ action: 'readMessage', input }));
  const navigation = window.webContents.on.mock.calls.find((call: unknown[]) => call[0] === 'did-start-navigation')![1];
  navigation({}, 'file:///app/index.html', false, true); pending.resolve(ready);
  expect(() => host.attach(capture)).toThrow();
  await expect(operation).rejects.toThrow(); expect(audio.play).not.toHaveBeenCalled();
});
it('rejects mismatched capture identity and ignores late events from another voice turn', async () => {
  const { host, events, window } = await setup();
  const capture = await host.begin({ purpose: 'conversation', sessionId: 'session-one', generation: 0 });
  await expect(host.cancel({ ...capture, voiceTurnId: randomUUID() })).rejects.toThrow();
  host.accept({ type: 'capture', ...capture, voiceTurnId: randomUUID(), state: 'review', text: 'should not be delivered' });
  expect(events.filter((event) => event.type === 'capture')).toHaveLength(0);
  host.attach(capture); expect(window.webContents.postMessage).toHaveBeenCalledOnce();
  await host.cancel(capture);
  host.accept({ type: 'capture', ...capture, state: 'review', text: 'late event' });
  expect(events.filter((event) => event.type === 'capture')).toHaveLength(0);
});
it('allows audio permissions only to an active Main-frame capture and never to camera/foreign frames', async () => {
  const { host, window } = await setup(); host.installPermissions(window);
  const check = window.webContents.session.setPermissionCheckHandler.mock.calls[0][0];
  const details = { isMainFrame: true, requestingUrl: window.webContents.getURL(), mediaType: 'audio' };
  expect(check(window.webContents, 'media', 'file://', details)).toBe(false);
  const capture = await host.begin({ purpose: 'validation', generation: 0 });
  expect(check(window.webContents, 'media', 'file://', details)).toBe(true);
  expect(check(window.webContents, 'media', 'file://', { ...details, mediaType: 'video' })).toBe(false);
  expect(check(window.webContents, 'media', 'file://', { ...details, isMainFrame: false })).toBe(false);
  expect(check({}, 'media', 'file://', details)).toBe(false);
  const permission = window.webContents.session.setPermissionRequestHandler.mock.calls[0][0], callback = vi.fn();
  permission(window.webContents, 'media', callback, { ...details, mediaTypes: ['audio', 'video'] }); expect(callback).toHaveBeenCalledWith(false);
  await host.cancel(capture); expect(check(window.webContents, 'media', 'file://', details)).toBe(false);
});
it('binds enablement to the current local recognition and synthesis configuration', async () => {
  const { host, settings, request } = await setup();
  request.mockResolvedValue({ captures: [], validation: { asr: true, tts: true }, validationSignature: '0'.repeat(64) });
  await expect(host.validateEnabled(settings)).rejects.toThrow();
  const validationSignature = createHash('sha256').update(JSON.stringify(settings.provider)).digest('hex');
  request.mockResolvedValue({ captures: [], validation: { asr: true, tts: true }, validationSignature });
  await expect(host.validateEnabled(settings)).resolves.toBeUndefined();
  const changed = structuredClone(settings); changed.provider.tts.speechRate = 15;
  await expect(host.validateEnabled(changed)).rejects.toThrow();
});
it('bounds both preparing and failed playback history at 100 before status schema validation', async () => {
  const { host, request, input } = await setup();
  let reject!: (reason: Error) => void;
  const pending = new Promise<never>((_resolve, fail) => { reject = fail; });
  request.mockImplementation(async (control) => control.action === 'readMessage' ? pending
    : control.action === 'status' ? { captures: [], validation: { asr: false, tts: false } } : undefined);
  const operations = Array.from({ length: 105 }, (_, index) => host.read({ ...input, messageId: `message-${index}` }).catch(() => undefined));
  await vi.waitFor(() => expect(request.mock.calls.filter(([control]) => control.action === 'readMessage')).toHaveLength(105));
  const preparing = await host.status(); expect(preparing.playbacks).toHaveLength(100);
  expect(preparing.playbacks.every((state) => state.state === 'preparing')).toBe(true);
  reject(new Error('offline synthesis unavailable')); await Promise.all(operations);
  const failed = await host.status(); expect(failed.playbacks).toHaveLength(100);
  expect(failed.playbacks.every((state) => state.state === 'failed')).toBe(true);
});
it('bounds explicit test playback history while retaining its public identity', async () => {
  const { host, settings } = await setup();
  settings.playback.quietHours = { start: '00:00', end: '23:59', timezone: 'UTC' };
  host.lockedState(true);
  for (let generation = 0; generation < 105; generation++) await host.test({ generation });
  const state = await host.status();
  expect(state.playbacks).toHaveLength(100);
  expect(state.playbacks.some((playback) => playback.generation === 104)).toBe(true);
  expect(state.playbacks.every((playback) => ['queued', 'interrupted', 'failed'].includes(playback.state))).toBe(true);
});
it('restores public identity for a completed preparation evicted from bounded history', async () => {
  const { host, request, ready, input, events, audio } = await setup();
  const pending = defer<typeof ready>(), fallback = request.getMockImplementation()!;
  request.mockImplementation(async (control) => control.action === 'readMessage' ? pending.promise : fallback(control));
  const operations = Array.from({ length: 105 }, (_, index) => host.read({ ...input, messageId: `message-${index}` }));
  await vi.waitFor(() => expect(request.mock.calls.filter(([control]) => control.action === 'readMessage')).toHaveLength(105));
  expect((await host.status()).playbacks).toHaveLength(100);
  pending.resolve(ready); await Promise.all(operations);
  await vi.waitFor(() => expect(audio.play).toHaveBeenCalledOnce());
  const queued = events.filter((event) => event.type === 'playback' && event.state === 'queued');
  expect(queued).toHaveLength(105);
  expect(queued.every((event) => event.type === 'playback' && event.generation === 0 && event.messageId?.startsWith('message-'))).toBe(true);
  expect((await host.status()).playbacks).toHaveLength(100);
});
