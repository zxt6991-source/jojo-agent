import { describe, expect, it } from 'vitest';
import manifest from '../../../tests/fixtures/speech/manifest.json';
import { replayVoiceTrace, type VoiceReplayFixture, type VoiceReplayEvent } from '../src/voice-replay';
import { TurnController } from '../src/turn-controller';
describe('voice replay assertions', () => {
  it('keeps synthetic event fixtures distinct from missing physical recordings', () => {
    expect(manifest.recordings).toHaveLength(13);
    for (const fixture of manifest.traces as VoiceReplayFixture[]) {
      expect(replayVoiceTrace(fixture)).toMatchObject({ passed: true, acousticEvidence: false });
    }
  });
  it('observes real turn-controller backchannel and interruption decisions', () => {
    for (const text of ['嗯', '等等，我问的是 ASR']) {
      const events: VoiceReplayEvent[] = []; let time = 0;
      const emit = (type: VoiceReplayEvent['type']) => events.push({ type, atMs: time++, generation: 1 });
      const controller = new TurnController({ context: { voiceSessionId: 'voice', turnId: 'turn', generation: 1 }, speakerBargeInVerified: true,
        onDuck: () => emit('playback.ducked'), onResume: () => { emit('interruption.backchannel'); emit('playback.resumed'); },
        onInterrupt: () => { emit('interruption.confirmed'); emit('playback.flushed'); emit('tts.cancelled'); } });
      controller.start(); controller.onPlaybackStarted(); emit('vad.started'); controller.onVadStarted(); emit('asr.final'); controller.onAsrFinal(text);
      const fixture = manifest.traces.find(item => item.id === (text === '嗯' ? 'backchannel' : 'interruption'))! as VoiceReplayFixture;
      const observedFixture = { ...fixture, expect: { ...fixture.expect, ordered: fixture.expect.ordered.filter(type => type !== 'asr.partial') } };
      expect(replayVoiceTrace(observedFixture, events).passed).toBe(true); controller.stop();
    }
  });
  it('rejects a VAD-only flush and any implicit Agent cancellation', () => {
    const fixture = manifest.traces[2] as VoiceReplayFixture;
    expect(replayVoiceTrace(fixture, [{ type: 'playback.flushed', atMs: 0, generation: 1 }, { type: 'agent_run.cancelled', atMs: 1, generation: 1 }]).failures)
      .toContain('voice_stop_cancelled_agent_run');
  });
});
