import { afterEach, describe, expect, it, vi } from 'vitest';
import { TurnController } from '../src/turn-controller';
import { classifyInterruption } from '../src/interruption-classifier';
afterEach(() => vi.useRealTimers());
const context = { voiceSessionId: 'session', turnId: 'turn', generation: 1 };
describe('gated turn detection and two-stage interruptions', () => {
  it('defaults to manual endpoint and disables speaker interruption without AEC evidence', () => {
    vi.useFakeTimers(); const endpoint = vi.fn(), duck = vi.fn();
    const turn = new TurnController({ context, onEndpoint: endpoint, onDuck: duck });
    turn.start(); turn.onVadStarted(); turn.onVadStopped(); turn.onSmartTurnComplete(); vi.advanceTimersByTime(10_000);
    expect(endpoint).not.toHaveBeenCalled(); turn.manualFinish(); expect(endpoint).toHaveBeenCalledOnce();
    turn.onPlaybackStarted(); turn.onVadStarted(); expect(duck).not.toHaveBeenCalled(); expect(turn.state()).toBe('assistant_speaking'); turn.stop();
  });
  it('waits through incomplete decisions and commits only one nonempty online final', () => {
    vi.useFakeTimers(); const commit = vi.fn(), endpoint = vi.fn();
    const turn = new TurnController({ context, autoEndpointVerified: true, onCommit: commit, onEndpoint: endpoint });
    turn.start(); turn.onVadStarted(); turn.onAsrPartial('我想让你'); turn.onVadStopped(); turn.onSmartTurnIncomplete();
    vi.advanceTimersByTime(500); turn.onVadStarted(); vi.advanceTimersByTime(5000); expect(endpoint).not.toHaveBeenCalled();
    turn.onVadStopped(); turn.onSmartTurnComplete(); expect(endpoint).toHaveBeenCalledOnce(); expect(commit).not.toHaveBeenCalled();
    turn.onAsrFinal('先看一下实现'); turn.onAsrFinal('重复 final'); expect(commit).toHaveBeenCalledExactlyOnceWith('先看一下实现', context); turn.stop();
  });
  it('ducks immediately but resumes backchannels, noise and empty final without new runs', () => {
    const duck = vi.fn(), resume = vi.fn(), interrupt = vi.fn(), commit = vi.fn();
    const turn = new TurnController({ context, speakerBargeInVerified: true, onDuck: duck, onResume: resume, onInterrupt: interrupt, onCommit: commit });
    turn.start(); turn.onPlaybackStarted(); turn.onVadStarted(); expect(duck).toHaveBeenCalledOnce(); expect(interrupt).not.toHaveBeenCalled();
    turn.onAsrPartial('嗯'); expect(resume).not.toHaveBeenCalled(); turn.onAsrFinal('嗯'); expect(resume).toHaveBeenCalledOnce();
    turn.onVadStarted(); turn.onAsrFinal(''); expect(resume).toHaveBeenCalledTimes(2); expect(commit).not.toHaveBeenCalled(); expect(interrupt).not.toHaveBeenCalled(); turn.stop();
  });
  it('confirms a real interruption, changes speech generation, and preserves the original turn generation', () => {
    const interrupted = vi.fn(), commit = vi.fn();
    const turn = new TurnController({ context, speakerBargeInVerified: true, onInterrupt: interrupted, onCommit: commit });
    turn.start(); turn.onPlaybackStarted(); turn.onVadStarted(); turn.onAsrFinal('等等，我问的是 ASR');
    expect(interrupted).toHaveBeenCalledWith(2); expect(commit).toHaveBeenCalledWith('等等，我问的是 ASR', context); expect(turn.accepts(context)).toBe(true); turn.stop();
  });
  it('mute rejects delayed ASR commits and stale turn reset is rejected', () => {
    const commit = vi.fn(), turn = new TurnController({ context, onCommit: commit });
    turn.start(); turn.onVadStarted(); turn.manualFinish(); turn.mute(); turn.onAsrFinal('晚到的结果'); expect(commit).not.toHaveBeenCalled();
    expect(() => turn.reset(context)).toThrow('stale_voice_generation'); turn.stop();
  });
  it('does not classify a partial acknowledgement as a final backchannel', () => {
    expect(classifyInterruption('好', false)).toBe('pending'); expect(classifyInterruption('好，但先停一下', true)).toBe('true');
  });
});

describe('continuous turn boundaries', () => {
  it('accepts a backchannel as a new ordinary utterance after playback ends', () => {
    const commit = vi.fn();
    const turn = new TurnController({ context, onCommit: commit });
    turn.start(); turn.onPlaybackStarted(); turn.onPlaybackEnded();
    turn.onVadStarted(); turn.onAsrFinal('嗯'); turn.manualFinish();
    expect(commit).toHaveBeenCalledExactlyOnceWith('嗯', context);
  });
  it('returns to listening when playback ends during a false interruption', () => {
    const discarded = vi.fn(), commit = vi.fn();
    const turn = new TurnController({ context, speakerBargeInVerified: true, onTurnDiscarded: discarded, onCommit: commit });
    turn.start(); turn.onPlaybackStarted(); turn.onVadStarted(); turn.onPlaybackEnded(); turn.onAsrFinal('嗯');
    expect(turn.state()).toBe('listening');
    expect(discarded).toHaveBeenCalledExactlyOnceWith(context, 'backchannel');
    expect(commit).not.toHaveBeenCalled();
  });
  it('preserves live playback when a discarded capture is reset', () => {
    const turn = new TurnController({ context, speakerBargeInVerified: true });
    turn.start(); turn.onPlaybackStarted(); turn.onVadStarted(); turn.onAsrFinal('');
    turn.reset({ ...context, turnId: 'next', generation: 2 });
    expect(turn.state()).toBe('assistant_speaking');
    turn.mute(); turn.reset({ ...context, turnId: 'muted-next', generation: 3 });
    expect(turn.state()).toBe('muted');
    turn.unmute(); expect(turn.state()).toBe('assistant_speaking');
  });
  it('does not accumulate fallback timers for repeated candidate silence events', () => {
    vi.useFakeTimers(); const resume = vi.fn(), discarded = vi.fn();
    const turn = new TurnController({ context, speakerBargeInVerified: true, onResume: resume, onTurnDiscarded: discarded });
    turn.start(); turn.onPlaybackStarted(); turn.onVadStarted(); turn.onVadStopped();
    vi.advanceTimersByTime(1000); turn.onVadStopped(); vi.advanceTimersByTime(2500);
    expect(resume).not.toHaveBeenCalled(); vi.advanceTimersByTime(500);
    expect(resume).toHaveBeenCalledOnce(); expect(discarded).toHaveBeenCalledOnce();
    turn.stop(); vi.runAllTimers(); expect(discarded).toHaveBeenCalledOnce();
  });
  it('fences repeated and reentrant endpoint decisions while waiting for final', () => {
    const commit = vi.fn(), endpoint = vi.fn();
    const turn = new TurnController({ context, autoEndpointVerified: true, onCommit: commit,
      onEndpoint: () => { endpoint(); turn.onVadStarted(); turn.onVadStopped(); turn.manualFinish(); } });
    turn.start(); turn.onVadStarted(); turn.onVadStopped(); turn.onSmartTurnComplete();
    turn.onSmartTurnComplete(); turn.manualFinish(); turn.onAsrFinal('第一条'); turn.onAsrFinal('重复 final');
    expect(endpoint).toHaveBeenCalledOnce(); expect(commit).toHaveBeenCalledExactlyOnceWith('第一条', context);
  });
  it('ignores playback callbacks after stop and never revives a muted microphone state', () => {
    const turn = new TurnController({ context });
    turn.start(); turn.mute(); turn.onPlaybackStarted(); turn.onPlaybackEnded();
    expect(turn.state()).toBe('muted');
    turn.stop(); turn.onPlaybackStarted(); expect(turn.state()).toBe('idle');
    expect(() => turn.reset({ ...context, generation: Number.NaN })).toThrow('stale_voice_generation');
  });
});
