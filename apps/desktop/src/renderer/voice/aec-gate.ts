export interface AecTopology {
  /** Include Electron build, macOS/hardware, input/output device ids and volume in this key. */
  environmentKey: string;
  ownership: 'same-context' | 'separate-host';
  echoCancellation: boolean;
}

export interface AecValidationReport {
  environmentKey: string;
  measuredAt: number;
  source: 'physical-device';
  tests: {
    playbackOnlyNoSpeechStart: boolean;
    userSpeechDetectedDuringPlayback: boolean;
    overlapAsrRecognizesUser: boolean;
  };
}

/** Requesting echoCancellation is not evidence. Replay fixtures cannot pass the physical gate. */
export function evaluateSpeakerBargeInGate(topology: AecTopology, report?: AecValidationReport): { enabled: boolean; reason: string } {
  if (topology.ownership !== 'same-context') return { enabled: false, reason: 'capture_playback_ownership_mismatch' };
  if (!topology.echoCancellation) return { enabled: false, reason: 'echo_cancellation_unavailable' };
  if (!report || report.source !== 'physical-device' || !Number.isFinite(report.measuredAt) || report.measuredAt <= 0) return { enabled: false, reason: 'physical_aec_validation_required' };
  if (!topology.environmentKey || topology.environmentKey !== report.environmentKey) return { enabled: false, reason: 'aec_environment_changed' };
  if (!report.tests.playbackOnlyNoSpeechStart || !report.tests.userSpeechDetectedDuringPlayback || !report.tests.overlapAsrRecognizesUser) return { enabled: false, reason: 'aec_validation_failed' };
  return { enabled: true, reason: 'physical_aec_gate_passed' };
}
