import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SpeechCaptureHandle, SpeechEvent } from '@desktop-agent/contracts';
import { ContinuousVoiceSession } from './continuous-session';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function setup(idleTimeoutMs = 120000) {
  const options = { startCapture: vi.fn<() => Promise<void>>(async () => undefined), cancelCapture: vi.fn(), stopPlayback: vi.fn(),
    canStart: vi.fn(() => true), autoRead: () => true, onState: vi.fn(), onNotice: vi.fn(), idleTimeoutMs };
  const session = new ContinuousVoiceSession(options), captures: SpeechCaptureHandle[] = [];
  options.startCapture.mockImplementation(async () => {
    const round = captures.length + 1;
    const handle: SpeechCaptureHandle = { captureId: `capture-${round}`, voiceTurnId: round === 1 ? 'v' : `v-${round}`, generation: round, sessionId: 's', purpose: 'conversation' };
    captures.push(handle); session.captureStarted(handle);
  });
  return { session, captures, ...options };
}
const capture = { voiceTurnId: 'v', generation: 1 };
const commit = { type: 'commit', sessionId: 's', ...capture, status: 'committed', runId: 'r' } as const;
const reply = { type: 'reply', sessionId: 's', messageId: 'm', runId: 'r', requestedReadAloud: true } as const;
const terminal = { type: 'session_run_finished', sessionId: 's', runId: 'r', outcome: 'completed' } as const;
function playback(playbackId: string, state: 'preparing' | 'played', nextOffset?: number): SpeechEvent {
  return { type: 'playback', sessionId: 's', playbackId, messageId: 'm', generation: 1, state, ...(nextOffset === undefined ? {} : { nextOffset }) };
}
it('opens no microphone until explicit start and never reopens during a Run or playback', async () => {
  const { session, startCapture } = setup();
  expect(startCapture).not.toHaveBeenCalled();
  session.start(); session.start(); expect(startCapture).toHaveBeenCalledTimes(1);
  session.finalReceived(capture); session.speech(commit); session.runStarted('r');
  await vi.advanceTimersByTimeAsync(1000); expect(startCapture).toHaveBeenCalledTimes(1);
  session.speech({ type: 'playback', sessionId: 's', playbackId: 'r', generation: 1, state: 'preparing' });
  session.runEnded('r', true);
  await vi.advanceTimersByTimeAsync(1000); expect(startCapture).toHaveBeenCalledTimes(1);
  session.speech({ type: 'playback', sessionId: 's', playbackId: 'r', generation: 1, state: 'played' });
  await vi.advanceTimersByTimeAsync(500); expect(startCapture).toHaveBeenCalledTimes(2);
  session.stop();
});
it('does not treat long complete-reading preparation and playback as user inactivity', async () => {
  const { session, startCapture, onNotice } = setup();
  session.start(); session.finalReceived(capture); session.speech(commit); session.speech(reply);
  session.speech(playback('complete', 'preparing')); session.speech(terminal);
  await vi.advanceTimersByTimeAsync(241_000);
  expect(session.state()).toBe('waiting'); expect(startCapture).toHaveBeenCalledTimes(1);
  expect(onNotice).not.toHaveBeenCalledWith(expect.stringContaining('空闲'));
  session.speech(playback('complete', 'played')); await vi.advanceTimersByTimeAsync(500);
  expect(startCapture).toHaveBeenCalledTimes(2); session.stop();
});
it('waits for legacy receipt and every full-reading segment, including terminal-before-commit ordering', async () => {
  const { session, startCapture } = setup();
  session.start(); session.finalReceived(capture); session.runEnded('r', true); session.speech(commit); session.speech(reply);
  await vi.advanceTimersByTimeAsync(500); expect(startCapture).toHaveBeenCalledTimes(1);
  session.speech(playback('a', 'preparing')); session.speech(playback('a', 'played', 200));
  await vi.advanceTimersByTimeAsync(20); session.speech(playback('b', 'preparing'));
  await vi.advanceTimersByTimeAsync(500); expect(startCapture).toHaveBeenCalledTimes(1);
  session.speech(playback('b', 'played'));
  await vi.advanceTimersByTimeAsync(500); expect(startCapture).toHaveBeenCalledTimes(2); session.stop();
});
it('requires explicit resume after mute; lock/sleep invalidation does not resume on unlock', async () => {
  const { session, startCapture, cancelCapture } = setup();
  session.start(); session.mute(); session.runEnded('r', true); session.speech(commit);
  await vi.advanceTimersByTimeAsync(1000); expect(startCapture).toHaveBeenCalledTimes(1);
  expect(cancelCapture).toHaveBeenCalledTimes(1);
  session.resume(); expect(startCapture).toHaveBeenCalledTimes(2);
  session.speech({ type: 'input_invalidated', reason: 'suspended' });
  await vi.advanceTimersByTimeAsync(1000); expect(startCapture).toHaveBeenCalledTimes(2); expect(session.state()).toBe('off');
});
it('keeps review drafts, stops on idle/error, and does not reopen over newly typed text', async () => {
  const { session, startCapture, canStart, onNotice } = setup();
  session.start(); session.finalReceived(capture);
  await vi.advanceTimersByTimeAsync(1000); expect(session.state()).toBe('review'); expect(startCapture).toHaveBeenCalledTimes(1);
  session.speech(commit); session.runEnded('r', true); canStart.mockReturnValue(false);
  await vi.advanceTimersByTimeAsync(500); expect(session.state()).toBe('off');
  canStart.mockReturnValue(true); session.start();
  await vi.advanceTimersByTimeAsync(120000); expect(session.state()).toBe('off'); expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('空闲'));
  session.start(); session.captureFailed(); expect(session.state()).toBe('off');
});
it('ignores every old Run event while recording a new capture', async () => {
  const { session, startCapture, cancelCapture } = setup();
  session.start(); session.finalReceived(capture); session.speech(commit); session.runEnded('r', true);
  await vi.advanceTimersByTimeAsync(500); expect(startCapture).toHaveBeenCalledTimes(2);
  for (const outcome of ['completed', 'failed', 'cancelled'] as const) session.speech({ ...terminal, outcome });
  session.speech(commit); session.speech(reply); session.speech(playback('a', 'preparing')); session.speech(playback('a', 'played', 200));
  session.runStarted('r'); session.runEnded('r', false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(session.state()).toBe('listening'); expect(startCapture).toHaveBeenCalledTimes(2); expect(cancelCapture).not.toHaveBeenCalled();
});
it('ignores stale capture commits and stale Run failures while waiting for the matching Run', async () => {
  const { session, startCapture } = setup();
  session.start(); session.captureStarted({ captureId: 'new-capture', voiceTurnId: 'new-v', generation: 2, sessionId: 's', purpose: 'conversation' });
  session.finalReceived({ voiceTurnId: 'new-v', generation: 2 });
  session.speech(commit); session.speech({ ...terminal, outcome: 'failed' }); session.speech(reply);
  expect(session.state()).toBe('review');
  session.speech({ ...commit, voiceTurnId: 'new-v', generation: 1, runId: 'new-r' }); expect(session.state()).toBe('review');
  session.speech({ ...commit, voiceTurnId: 'new-v', generation: 2, runId: 'new-r' });
  session.speech({ ...terminal, outcome: 'failed' }); session.runStarted('r'); session.speech(playback('old', 'preparing'));
  session.runEnded('new-r', true); await vi.advanceTimersByTimeAsync(500);
  expect(session.state()).toBe('listening'); expect(startCapture).toHaveBeenCalledTimes(2);
});
it('replays a fast terminal, reply and playback arriving before matching commit', async () => {
  const { session, startCapture } = setup();
  session.start(); session.finalReceived(capture);
  session.speech(terminal); session.speech(playback('a', 'preparing')); session.speech(reply);
  session.speech(playback('a', 'played', 200)); session.speech(commit);
  await vi.advanceTimersByTimeAsync(1000); expect(session.state()).toBe('waiting'); expect(startCapture).toHaveBeenCalledTimes(1);
  session.speech(playback('b', 'preparing')); session.speech(playback('b', 'played'));
  await vi.advanceTimersByTimeAsync(500); expect(startCapture).toHaveBeenCalledTimes(2);
});
it('handles an already played single segment before reply and commit without a false read deadline', async () => {
  const { session, startCapture, onNotice } = setup();
  session.start(); session.finalReceived(capture);
  session.speech(terminal); session.speech(playback('a', 'preparing')); session.speech(playback('a', 'played')); session.speech(reply); session.speech(commit);
  await vi.advanceTimersByTimeAsync(500); expect(startCapture).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(35000); expect(onNotice).not.toHaveBeenCalledWith(expect.stringContaining('后续朗读')); session.stop();
});
it('accepts matching legacy preparation before its reply after commit', async () => {
  const { session, startCapture } = setup();
  session.start(); session.finalReceived(capture); session.speech(commit); session.speech(terminal);
  session.speech(playback('a', 'preparing')); session.speech(reply);
  await vi.advanceTimersByTimeAsync(1000); expect(startCapture).toHaveBeenCalledTimes(1);
  session.speech(playback('a', 'played'));
  await vi.advanceTimersByTimeAsync(500); expect(startCapture).toHaveBeenCalledTimes(2);
});
it('resumes after an already played segment is matched by a delayed postcommit reply', async () => {
  const { session, startCapture } = setup();
  session.start(); session.finalReceived(capture); session.speech(commit); session.speech(terminal);
  session.speech(playback('a', 'preparing')); session.speech(playback('a', 'played')); session.speech(reply);
  await vi.advanceTimersByTimeAsync(500); expect(startCapture).toHaveBeenCalledTimes(2);
});
it('does not let unrelated playback clear a full-reading continuation wait', async () => {
  const { session, startCapture } = setup();
  session.start(); session.finalReceived(capture); session.speech(commit); session.speech(terminal); session.speech(reply);
  session.speech(playback('a', 'preparing')); session.speech(playback('a', 'played', 200));
  session.speech({ type: 'playback', sessionId: 's', playbackId: 'old', messageId: 'old-message', generation: 1, state: 'preparing' });
  session.speech({ type: 'playback', sessionId: 's', playbackId: 'old', messageId: 'old-message', generation: 1, state: 'played' });
  await vi.advanceTimersByTimeAsync(1000); expect(startCapture).toHaveBeenCalledTimes(1);
  session.speech(playback('b', 'preparing')); session.speech(playback('b', 'played'));
  await vi.advanceTimersByTimeAsync(500); expect(startCapture).toHaveBeenCalledTimes(2);
});
it('bounds unmatched precommit events and does not replay evicted old Runs into a new capture', async () => {
  const { session, startCapture } = setup();
  session.start(); session.finalReceived(capture);
  for (let index = 0; index < 200; index++) session.speech({ ...terminal, runId: `old-${index}`, outcome: 'failed' });
  session.speech(terminal); session.speech(commit);
  await vi.advanceTimersByTimeAsync(500); expect(startCapture).toHaveBeenCalledTimes(2);
});
it('does not let a cancelled old microphone start failure stop a newly started session', async () => {
  let reject!: (error: Error) => void;
  const { session, startCapture } = setup();
  startCapture.mockImplementationOnce(() => new Promise<void>((_resolve, no) => { reject = no; }));
  session.start(); session.stop(); session.start(); reject(new Error('old grant'));
  await vi.advanceTimersByTimeAsync(0); expect(session.state()).toBe('listening'); expect(startCapture).toHaveBeenCalledTimes(2); session.stop();
});
it('discards only the failed turn, limits automatic recovery to twice, then requires explicit resume', async () => {
  const { session, captures, startCapture, cancelCapture, stopPlayback, onNotice } = setup();
  session.start();
  for (let attempt = 0; attempt < 2; attempt++) {
    const handle = captures.at(-1)!;
    session.captureFailed({ handle, code: attempt ? 'empty_result' : 'invalid_audio', message: 'discard this turn' });
    expect(session.state()).toBe('recovering');
    expect(cancelCapture).toHaveBeenCalledTimes(attempt + 1);
    session.finalReceived(handle); session.speech({ ...commit, voiceTurnId: handle.voiceTurnId, generation: handle.generation });
    await vi.advanceTimersByTimeAsync(999); expect(startCapture).toHaveBeenCalledTimes(attempt + 1);
    await vi.advanceTimersByTimeAsync(1); expect(session.state()).toBe('listening');
  }
  session.captureFailed({ handle: captures.at(-1)!, code: 'empty_result', message: 'third failure' });
  expect(session.state()).toBe('muted');
  expect(startCapture).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(5000); expect(startCapture).toHaveBeenCalledTimes(3);
  expect(onNotice).toHaveBeenLastCalledWith(expect.stringContaining('恢复收音'));
  // The only playback stop was muting at the limit; no Run cancellation port exists.
  expect(stopPlayback).toHaveBeenCalledTimes(1);
  session.resume(); expect(startCapture).toHaveBeenCalledTimes(4);
  expect(onNotice).toHaveBeenLastCalledWith('');
  session.stop();
});
it('ignores failures and finals from an earlier capture after recovery and while the matching Run is executing', async () => {
  const { session, captures, startCapture, cancelCapture } = setup();
  session.start(); const old = captures[0]!;
  session.captureFailed({ handle: old, code: 'invalid_audio', message: 'gap' });
  await vi.advanceTimersByTimeAsync(1000); const current = captures[1]!;
  session.captureFailed({ handle: old, code: 'invalid_audio', message: 'late failure' });
  session.finalReceived(old); expect(session.state()).toBe('listening');
  session.captureFailed({ handle: { ...current, captureId: 'wrong' }, code: 'empty_result', message: 'wrong capture' });
  session.captureFailed({ handle: { ...current, generation: 999 }, code: 'empty_result', message: 'wrong generation' });
  expect(cancelCapture).toHaveBeenCalledTimes(1);
  session.finalReceived(current);
  session.speech({ ...commit, voiceTurnId: current.voiceTurnId, generation: current.generation });
  session.captureFailed({ handle: current, code: 'invalid_audio', message: 'late draft teardown' });
  expect(session.state()).toBe('waiting');
  await vi.advanceTimersByTimeAsync(2000); expect(startCapture).toHaveBeenCalledTimes(2); session.stop();
});
it.each(['locked', 'suspended', 'configuration', 'navigation'] as const)('cancels delayed recovery after %s invalidation', async reason => {
  const { session, captures, startCapture } = setup();
  session.start(); session.captureFailed({ handle: captures[0]!, code: 'invalid_audio', message: 'gap' });
  session.speech({ type: 'input_invalidated', reason });
  await vi.advanceTimersByTimeAsync(10000);
  expect(session.state()).toBe('off'); expect(startCapture).toHaveBeenCalledTimes(1);
});
it.each(['stop', 'mute'] as const)('does not reopen after explicit %s during recovery', async action => {
  const { session, captures, startCapture } = setup();
  session.start(); session.captureFailed({ handle: captures[0]!, code: 'invalid_audio', message: 'gap' });
  session[action](); await vi.advanceTimersByTimeAsync(2000);
  expect(session.state()).toBe(action === 'stop' ? 'off' : 'muted'); expect(startCapture).toHaveBeenCalledTimes(1);
});
it('does not extend the original idle deadline after a failed recording', async () => {
  const { session, captures, startCapture, onNotice } = setup(2500);
  session.start(); await vi.advanceTimersByTimeAsync(1000);
  session.captureFailed({ handle: captures[0]!, code: 'empty_result', message: 'silence' });
  await vi.advanceTimersByTimeAsync(1000);
  expect(session.state()).toBe('listening'); expect(startCapture).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(500);
  expect(session.state()).toBe('off'); expect(startCapture).toHaveBeenCalledTimes(2);
  expect(onNotice).toHaveBeenLastCalledWith(expect.stringContaining('空闲'));
});
it('rechecks new text and tasks before automatically reopening the microphone', async () => {
  const { session, captures, startCapture, canStart } = setup();
  session.start(); session.captureFailed({ handle: captures[0]!, code: 'empty_result', message: 'silence' });
  canStart.mockReturnValue(false); await vi.advanceTimersByTimeAsync(1000);
  expect(session.state()).toBe('off'); expect(startCapture).toHaveBeenCalledTimes(1);
});
it('accepts an explicit capture during the retry delay without replacing it later', async () => {
  const { session, captures, startCapture } = setup();
  session.start(); session.captureFailed({ handle: captures[0]!, code: 'invalid_audio', message: 'gap' });
  const manual = { ...captures[0]!, captureId: 'manual', voiceTurnId: 'manual-turn', generation: 50 };
  session.captureStarted(manual);
  await vi.advanceTimersByTimeAsync(2000); expect(startCapture).toHaveBeenCalledTimes(1); expect(session.state()).toBe('listening');
  session.finalReceived(manual); expect(session.state()).toBe('review'); session.stop();
});
it.each(['auth_failed', 'local_unavailable', 'resource_denied', 'cancelled', 'timeout', 'protocol_error'] as const)('does not automatically retry %s', async code => {
  const { session, captures, startCapture, onNotice } = setup();
  session.start(); session.captureFailed({ handle: captures[0]!, code, message: 'needs attention' });
  await vi.advanceTimersByTimeAsync(2000);
  expect(session.state()).toBe('off'); expect(startCapture).toHaveBeenCalledTimes(1); expect(onNotice).toHaveBeenLastCalledWith('needs attention');
});
it('resets the retry budget only after a valid final or explicit resume', async () => {
  const { session, captures, startCapture } = setup();
  session.start(); session.captureFailed({ handle: captures[0]!, code: 'empty_result', message: 'silence' });
  await vi.advanceTimersByTimeAsync(1000);
  const valid = captures[1]!; session.finalReceived(valid);
  session.speech({ ...commit, voiceTurnId: valid.voiceTurnId, generation: valid.generation }); session.speech(terminal);
  await vi.advanceTimersByTimeAsync(500);
  for (let index = 0; index < 2; index++) {
    session.captureFailed({ handle: captures.at(-1)!, code: 'invalid_audio', message: 'gap' });
    await vi.advanceTimersByTimeAsync(1000); expect(session.state()).toBe('listening');
  }
  expect(startCapture).toHaveBeenCalledTimes(5); session.stop();
});
