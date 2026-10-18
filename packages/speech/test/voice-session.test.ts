import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SidecarEvent, SpeechSidecarClient } from '../src/sidecar';
import { VoiceSession, type VoiceSessionOptions } from '../src/voice-session';
const context = { voiceSessionId: 'voice', captureId: 'capture', turnId: 'turn', generation: 1 };
const sessions: VoiceSession[] = [];
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(acquire = vi.fn<(signal: AbortSignal) => Promise<void>>(async () => undefined), overrides: Partial<VoiceSessionOptions> = {}) {
  let listener: ((event: SidecarEvent) => void) | undefined;
  const sidecar = { open: vi.fn<() => Promise<void>>(async () => undefined), close: vi.fn<() => Promise<void>>(async () => undefined), reset: vi.fn<() => Promise<void>>(async () => undefined),
    subscribe: vi.fn((handler: (event: SidecarEvent) => void) => { listener = handler; return () => { if (listener === handler) listener = undefined; }; }),
    finish: vi.fn<() => Promise<void>>(async () => undefined), sendAudio: vi.fn<() => Promise<void>>(async () => undefined) };
  const release = vi.fn();
  const session = new VoiceSession({ context, sidecar: sidecar as unknown as SpeechSidecarClient, acquireMicrophone: acquire, releaseMicrophone: release, ...overrides });
  sessions.push(session);
  return { sidecar, session, release, acquire, emit: (event: SidecarEvent) => listener?.(event) };
}
afterEach(async () => { await Promise.all(sessions.splice(0).map(session => session.stop())); vi.useRealTimers(); });
describe('explicit continuous voice resource lifecycle', () => {
  it('never opens microphone on construction and closes it on lock/sleep', async () => {
    const { session, acquire, release } = setup();
    expect(acquire).not.toHaveBeenCalled(); await session.start(); expect(session.state()).toBe('listening');
    await session.onScreenLock(); expect(session.state()).toBe('idle'); expect(release).toHaveBeenCalled();
    await session.start(); await session.onSleep(); expect(session.state()).toBe('idle');
  });
  it('mute advances capture generation and drains no new audio until explicit unmute', async () => {
    const { session, sidecar, release } = setup(); await session.start();
    session.mute(); await session.audio(new Uint8Array([1, 2])); expect(sidecar.sendAudio).not.toHaveBeenCalled(); expect(release).toHaveBeenCalled();
    await session.unmute();
    expect(sidecar.reset).toHaveBeenCalledWith(expect.objectContaining({ generation: 2 }));
    await session.audio(new Uint8Array([3, 4])); expect(sidecar.sendAudio).toHaveBeenCalledWith(expect.objectContaining({ generation: 2 }), 0, new Uint8Array([3, 4]));
  });
  it('a pending microphone grant cannot revive a session stopped while starting', async () => {
    const grant = deferred(); const acquire = vi.fn(() => grant.promise);
    const { session, release } = setup(acquire); const opening = session.start();
    await vi.waitFor(() => expect(acquire).toHaveBeenCalled()); await session.stop(); grant.resolve(); await opening;
    expect(session.state()).toBe('idle'); expect(release).toHaveBeenCalled();
  });
  it('coalesces repeated start and never closes a newer session from a stale grant', async () => {
    const firstGrant = deferred(); const acquire = vi.fn<(signal: AbortSignal) => Promise<void>>()
      .mockImplementationOnce(() => firstGrant.promise).mockResolvedValue(undefined);
    const { session, sidecar, release } = setup(acquire);
    const opening = session.start(); expect(session.start()).toBe(opening);
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());
    await session.stop(); await session.start(); const released = release.mock.calls.length;
    firstGrant.resolve(); await opening;
    expect(session.state()).toBe('listening'); expect(release).toHaveBeenCalledTimes(released);
    expect(sidecar.close).toHaveBeenCalledTimes(1); expect(session.getContext().generation).toBe(2);
  });
  it('serializes close before a new sidecar open when stop races opening', async () => {
    const opened = deferred(); const { session, sidecar } = setup();
    sidecar.open.mockImplementationOnce(() => opened.promise);
    const first = session.start(); await vi.waitFor(() => expect(sidecar.open).toHaveBeenCalledOnce());
    const stopped = session.stop(), restarted = session.start();
    expect(sidecar.open).toHaveBeenCalledTimes(1); opened.resolve();
    await Promise.all([first, stopped, restarted]);
    expect(sidecar.close).toHaveBeenCalledWith(context);
    expect(sidecar.open.mock.invocationCallOrder[1]).toBeGreaterThan(sidecar.close.mock.invocationCallOrder[0] ?? 0);
    expect(session.getContext().generation).toBe(2); expect(session.state()).toBe('listening');
  });
  it('can mute during a pending permission grant and waits for an explicit new unmute', async () => {
    const grant = deferred(); const acquire = vi.fn<(signal: AbortSignal) => Promise<void>>()
      .mockImplementationOnce(() => grant.promise).mockResolvedValue(undefined);
    const { session } = setup(acquire); const opening = session.start();
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce()); session.mute(); grant.resolve(); await opening;
    expect(session.state()).toBe('muted'); expect(acquire.mock.calls[0]?.[0].aborted).toBe(true);
    await session.unmute(); expect(session.state()).toBe('listening'); expect(acquire).toHaveBeenCalledTimes(2);
  });
  it('can mute while opening the sidecar without ever opening the microphone', async () => {
    const opened = deferred(); const { session, sidecar, acquire } = setup();
    sidecar.open.mockImplementationOnce(() => opened.promise);
    const opening = session.start(); await vi.waitFor(() => expect(sidecar.open).toHaveBeenCalledOnce());
    session.mute(); opened.resolve(); await opening;
    expect(acquire).not.toHaveBeenCalled(); expect(session.state()).toBe('muted');
    await session.unmute(); expect(acquire).toHaveBeenCalledOnce(); expect(session.state()).toBe('listening');
  });
  it('stops while an unmute grant is pending without reviving capture', async () => {
    const grant = deferred(); const acquire = vi.fn<(signal: AbortSignal) => Promise<void>>()
      .mockResolvedValueOnce(undefined).mockImplementationOnce(() => grant.promise);
    const { session } = setup(acquire); await session.start(); session.mute();
    const unmuting = session.unmute(); await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(2));
    await session.stop(); grant.resolve(); await unmuting;
    expect(session.state()).toBe('idle'); expect(acquire.mock.calls[1]?.[0].aborted).toBe(true);
  });
  it('closes the actual open context if a queued reset is cancelled by stop', async () => {
    const { session, sidecar } = setup(); await session.start();
    session.mute(); const stopped = session.stop(); await stopped;
    expect(sidecar.reset).not.toHaveBeenCalled(); expect(sidecar.close).toHaveBeenCalledWith(context);
  });
  it('cleans up microphone permission failures and reports an error', async () => {
    const acquire = vi.fn(async () => { throw new Error('denied'); }); const { session, sidecar, release } = setup(acquire);
    await expect(session.start()).rejects.toThrow('denied');
    expect(session.state()).toBe('error'); expect(release).toHaveBeenCalled(); expect(sidecar.close).toHaveBeenCalledWith(context);
  });
  it('queues close before a restart triggered by the idle state observer', async () => {
    let restart = false, restarted: Promise<void> | undefined;
    const { session, sidecar } = setup(undefined, { onState: state => {
      if (state === 'idle' && restart) { restart = false; restarted = session.start(); }
    } });
    await session.start(); restart = true; await session.stop(); await restarted;
    expect(session.state()).toBe('listening');
    expect(sidecar.open.mock.invocationCallOrder[1]).toBeGreaterThan(sidecar.close.mock.invocationCallOrder[0] ?? 0);
  });
  it('ends a muted session on idle timeout', async () => {
    vi.useFakeTimers(); const { session, release } = setup(undefined, { idleTimeoutMs: 1000 });
    await session.start(); session.mute(); await vi.advanceTimersByTimeAsync(1000);
    expect(session.state()).toBe('idle'); expect(release).toHaveBeenCalled();
  });
});

describe('voice capture event generation fences', () => {
  it('returns a cloned context and rejects stale capture, generation and errors', async () => {
    const commit = vi.fn(); const { session, emit } = setup(undefined, { onCommit: commit }); await session.start();
    const clone = session.getContext(); clone.generation = 100; expect(session.getContext()).toEqual(context);
    emit({ type: 'error', ...context, generation: 0, code: 'stale' });
    emit({ type: 'vad.started', ...context, captureId: 'other', atMs: 0 });
    expect(session.state()).toBe('listening'); session.manualFinish();
    emit({ type: 'asr.final', ...context, captureId: 'other', text: 'stale capture' });
    expect(commit).not.toHaveBeenCalled(); emit({ type: 'asr.final', ...context, text: '当前输入' });
    expect(commit).toHaveBeenCalledExactlyOnceWith('当前输入', expect.objectContaining(context));
  });
  it('resets discarded backchannel ASR while keeping playback and ignoring its delayed final', async () => {
    const commit = vi.fn(), discarded = vi.fn();
    const { session, sidecar, emit } = setup(undefined, { speakerBargeInVerified: true, onCommit: commit, onTurnDiscarded: discarded });
    await session.start(); session.playbackStarted();
    emit({ type: 'vad.started', ...context, atMs: 0 }); emit({ type: 'asr.final', ...context, text: '嗯' });
    await vi.waitFor(() => expect(sidecar.reset).toHaveBeenCalledOnce());
    expect(discarded).toHaveBeenCalledWith(expect.objectContaining(context), 'backchannel');
    expect(session.getContext().generation).toBe(2); expect(session.state()).toBe('assistant_speaking');
    emit({ type: 'asr.final', ...context, text: '迟到的候选 final' }); expect(commit).not.toHaveBeenCalled();
    const current = session.getContext(); emit({ type: 'vad.started', ...current, atMs: 10 });
    emit({ type: 'asr.final', ...current, text: '等等，先看这里' });
    expect(commit).toHaveBeenCalledExactlyOnceWith('等等，先看这里', expect.objectContaining({ generation: 2 }));
  });
  it('discards only the current turn on a severe audio gap', async () => {
    const { session, sidecar, acquire, emit } = setup(); await session.start();
    emit({ type: 'audio.gap', ...context, missingFrames: 8, turnReset: true });
    await vi.waitFor(() => expect(sidecar.reset).toHaveBeenCalledOnce());
    expect(sidecar.close).not.toHaveBeenCalled(); expect(acquire).toHaveBeenCalledOnce();
    expect(session.state()).toBe('listening'); expect(session.getContext().generation).toBe(2);
  });
  it('closes a muted session on a current fatal sidecar error', async () => {
    const { session, sidecar, emit } = setup(); await session.start(); session.mute();
    await vi.waitFor(() => expect(sidecar.reset).toHaveBeenCalledOnce());
    emit({ type: 'error', ...session.getContext(), code: 'crashed', fatal: true });
    await vi.waitFor(() => expect(sidecar.close).toHaveBeenCalledOnce());
    expect(session.state()).toBe('error');
  });
  it('does not let a late endpoint write failure mark a newer turn as failed', async () => {
    const finish = deferred(); const { session, sidecar } = setup(); await session.start();
    sidecar.finish.mockImplementationOnce(() => finish.promise); session.manualFinish();
    await session.nextTurn({ ...context, turnId: 'next', generation: 2 }); finish.reject(new Error('old write'));
    await Promise.resolve(); expect(session.state()).toBe('listening'); expect(sidecar.close).not.toHaveBeenCalled();
  });
});
