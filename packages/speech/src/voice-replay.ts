export const VOICE_REPLAY_EVENT_TYPES = [
  'vad.started', 'vad.stopped', 'asr.partial', 'asr.final', 'turn.completed',
  'interruption.candidate', 'interruption.backchannel', 'interruption.rejected', 'interruption.confirmed',
  'playback.ducked', 'playback.resumed', 'playback.flushed', 'playback.stopped',
  'tts.cancelled', 'agent_run.created', 'agent_run.cancelled', 'task.cancel_requested',
  'capture.frame_gap', 'sidecar.crashed', 'session.recovered', 'session.muted', 'session.locked', 'capture.stopped'
] as const;
export type VoiceReplayEventType = typeof VOICE_REPLAY_EVENT_TYPES[number];
/** Fixture events deliberately omit transcript and PCM. Consented audio lives
 * outside telemetry; an event trace is not evidence that AEC/ASR passed. */
export interface VoiceReplayEvent { type: VoiceReplayEventType; atMs: number; generation: number }
export interface VoiceReplayFixture {
  id: string;
  provenance: 'synthetic_event_trace' | 'target_device_recording';
  audioStatus: 'missing' | 'available';
  generation: number;
  events: VoiceReplayEvent[];
  expect: { ordered: VoiceReplayEventType[]; forbidden?: VoiceReplayEventType[]; ignoredStaleEvents?: number };
}
export interface VoiceReplayResult {
  passed: boolean;
  acceptedEvents: number;
  ignoredStaleEvents: number;
  failures: string[];
  /** Only real recordings can contribute to a measured acoustic release gate. */
  acousticEvidence: boolean;
}

/** Check the event contract against a supplied trace. Device integrations can
 * replace fixture.events with their actual observed events without changing the
 * assertions. Generation-stale events can never affect the active turn. */
export function replayVoiceTrace(fixture: VoiceReplayFixture, observed: readonly VoiceReplayEvent[] = fixture.events): VoiceReplayResult {
  if (!fixture.id || fixture.id.length > 128 || !Number.isSafeInteger(fixture.generation) || fixture.generation < 0 || observed.length > 10_000) throw new Error('invalid_voice_replay_fixture');
  const failures: string[] = [];
  const accepted: VoiceReplayEvent[] = [];
  let ignoredStaleEvents = 0;
  let previousMs = -1;
  let ducked = false;
  let confirmed = false;
  let taskCancellationRequested = false;
  for (const event of observed) {
    if (!VOICE_REPLAY_EVENT_TYPES.includes(event.type) || !Number.isFinite(event.atMs) || event.atMs < previousMs
      || !Number.isSafeInteger(event.generation) || event.generation < 0) throw new Error('invalid_voice_replay_event');
    previousMs = event.atMs;
    if (event.generation !== fixture.generation) { ignoredStaleEvents++; continue; }
    accepted.push(event);
    if (event.type === 'task.cancel_requested') taskCancellationRequested = true;
    if (event.type === 'playback.ducked') ducked = true;
    if (event.type === 'interruption.confirmed') {
      if (!ducked) failures.push('interruption_confirmed_before_duck');
      confirmed = true;
    }
    if (event.type === 'playback.flushed' && !confirmed) failures.push('playback_flushed_without_confirmed_interruption');
    if (event.type === 'playback.resumed') {
      if (!ducked || confirmed) failures.push('invalid_false_interruption_resume');
      ducked = false;
    }
    if (event.type === 'agent_run.cancelled' && !taskCancellationRequested) failures.push('voice_stop_cancelled_agent_run');
  }
  let expectationIndex = 0;
  for (const event of accepted) {
    if (event.type === fixture.expect.ordered[expectationIndex]) expectationIndex++;
    if (fixture.expect.forbidden?.includes(event.type)) failures.push(`forbidden_event:${event.type}`);
  }
  if (expectationIndex !== fixture.expect.ordered.length) failures.push(`missing_ordered_event:${fixture.expect.ordered[expectationIndex]}`);
  if (fixture.expect.ignoredStaleEvents !== undefined && fixture.expect.ignoredStaleEvents !== ignoredStaleEvents) failures.push('unexpected_stale_event_count');
  return {
    passed: !failures.length, acceptedEvents: accepted.length, ignoredStaleEvents, failures,
    acousticEvidence: fixture.provenance === 'target_device_recording' && fixture.audioStatus === 'available'
  };
}

/** Feed replay input into a real turn/audio implementation with an injectable
 * clock. Default execution is deterministic and does not sleep in tests. */
export async function playVoiceReplay(
  fixture: VoiceReplayFixture,
  dispatch: (event: VoiceReplayEvent) => void | Promise<void>,
  advance: (deltaMs: number) => void | Promise<void> = () => undefined
): Promise<void> {
  replayVoiceTrace(fixture);
  let elapsed = 0;
  for (const event of fixture.events) {
    await advance(event.atMs - elapsed);
    elapsed = event.atMs;
    if (event.generation === fixture.generation) await dispatch({ ...event });
  }
}
