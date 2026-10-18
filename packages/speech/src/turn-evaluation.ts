/** Audio labels and numeric endpoint observations only. No transcript or audio
 * is retained, and a passing replay never changes a runtime release gate. */
export type EndpointAnnotation = { audioSha256: string } & (
  | { kind: 'turn'; speechEndMs: number; maxLatencyMs: number }
  | { kind: 'no_endpoint' }
);
export interface TurnCorpusRecording {
  id: string;
  wav: string;
  status: 'missing' | 'available';
  provenance?: 'target_device_recording' | 'reference_recording' | 'synthetic_audio';
  consentConfirmed?: boolean;
  environmentId?: string;
  language?: 'zh';
  endpoint?: EndpointAnnotation;
}
export interface EndpointThresholds {
  maxPrematureRate: number;
  maxMissedRate: number;
  maxP95LatencyMs: number;
  maxFalseEndpointRate?: number;
}
export interface TurnCorpus {
  version: 1;
  recordings: TurnCorpusRecording[];
  endpointEvaluation: { requiredIds: string[]; thresholds: EndpointThresholds | null };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_turn_corpus');
  return value as Record<string, unknown>;
}
function identifier(value: unknown): value is string { return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/u.test(value); }
function milliseconds(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 60_000; }
export function parseTurnCorpus(value: unknown): TurnCorpus {
  const input = object(value), config = object(input.endpointEvaluation);
  if (input.version !== 1 || !Array.isArray(input.recordings) || !input.recordings.length || input.recordings.length > 128) throw new Error('invalid_turn_corpus');
  const ids = new Set<string>();
  const recordings = input.recordings.map((entry): TurnCorpusRecording => {
    const item = object(entry);
    if (!identifier(item.id) || ids.has(item.id) || typeof item.wav !== 'string' || item.wav.length > 256
      || !item.wav.toLowerCase().endsWith('.wav') || /[\\:]/u.test(item.wav) || Array.from(item.wav).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
      || item.wav.startsWith('/') || item.wav.split('/').some(part => !part || part === '.' || part === '..')
      || !['missing', 'available'].includes(item.status as string)
      || item.provenance !== undefined && !['target_device_recording', 'reference_recording', 'synthetic_audio'].includes(item.provenance as string)
      || item.consentConfirmed !== undefined && typeof item.consentConfirmed !== 'boolean'
      || item.environmentId !== undefined && !identifier(item.environmentId)
      || item.language !== undefined && item.language !== 'zh') throw new Error('invalid_turn_recording');
    ids.add(item.id);
    let endpoint: EndpointAnnotation | undefined;
    if (item.endpoint !== undefined) {
      const label = object(item.endpoint);
      if (typeof label.audioSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(label.audioSha256)) throw new Error('invalid_endpoint_annotation');
      if (label.kind === 'turn' && milliseconds(label.speechEndMs) && milliseconds(label.maxLatencyMs) && label.speechEndMs + label.maxLatencyMs <= 60_000) {
        endpoint = { kind: 'turn', audioSha256: label.audioSha256, speechEndMs: label.speechEndMs, maxLatencyMs: label.maxLatencyMs };
      } else if (label.kind === 'no_endpoint') endpoint = { kind: 'no_endpoint', audioSha256: label.audioSha256 };
      else throw new Error('invalid_endpoint_annotation');
    }
    return { id: item.id, wav: item.wav, status: item.status as TurnCorpusRecording['status'],
      ...(item.provenance === undefined ? {} : { provenance: item.provenance as NonNullable<TurnCorpusRecording['provenance']> }),
      ...(item.consentConfirmed === undefined ? {} : { consentConfirmed: item.consentConfirmed as boolean }),
      ...(item.environmentId === undefined ? {} : { environmentId: item.environmentId as string }),
      ...(item.language === undefined ? {} : { language: 'zh' }), ...(endpoint ? { endpoint } : {}) };
  });
  if (!Array.isArray(config.requiredIds) || !config.requiredIds.length || !config.requiredIds.every(id => typeof id === 'string' && ids.has(id))
    || new Set(config.requiredIds).size !== config.requiredIds.length) throw new Error('invalid_required_turn_cases');
  let thresholds: EndpointThresholds | null = null;
  if (config.thresholds !== null) {
    const t = object(config.thresholds), rate = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
    if (!rate(t.maxPrematureRate) || !rate(t.maxMissedRate) || !milliseconds(t.maxP95LatencyMs)
      || t.maxFalseEndpointRate !== undefined && !rate(t.maxFalseEndpointRate)) throw new Error('invalid_endpoint_thresholds');
    thresholds = { maxPrematureRate: t.maxPrematureRate as number, maxMissedRate: t.maxMissedRate as number, maxP95LatencyMs: t.maxP95LatencyMs,
      ...(t.maxFalseEndpointRate === undefined ? {} : { maxFalseEndpointRate: t.maxFalseEndpointRate as number }) };
  }
  return { version: 1, recordings, endpointEvaluation: { requiredIds: config.requiredIds as string[], thresholds } };
}
export type EndpointOutcome = 'unannotated' | 'on_time' | 'premature' | 'late' | 'missed' | 'correct_rejection' | 'false_endpoint';
export interface EndpointScore { outcome: EndpointOutcome; latencyMs: number | null }
export function scoreEndpoint(annotation: EndpointAnnotation | undefined, durationMs: number, endpointAtMs: number | null): EndpointScore {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 60_000
    || endpointAtMs !== null && (!Number.isFinite(endpointAtMs) || endpointAtMs < 0)) throw new Error('invalid_endpoint_observation');
  if (!annotation) return { outcome: 'unannotated', latencyMs: null };
  if (annotation.kind === 'no_endpoint') return { outcome: endpointAtMs === null ? 'correct_rejection' : 'false_endpoint', latencyMs: null };
  // Without trailing audio through the deadline, EOF could suppress the timer;
  // such a clip cannot establish a missed endpoint.
  if (annotation.speechEndMs + annotation.maxLatencyMs > durationMs) throw new Error('insufficient_labeled_audio');
  if (endpointAtMs === null) return { outcome: 'missed', latencyMs: null };
  const latencyMs = endpointAtMs - annotation.speechEndMs;
  return { outcome: latencyMs < 0 ? 'premature' : latencyMs > annotation.maxLatencyMs ? 'late' : 'on_time', latencyMs };
}
export interface EndpointCaseResult {
  id: string;
  status: 'missing' | 'ready' | 'blocked' | 'measured' | 'error';
  issues: string[];
  physicalChineseEvidence: boolean;
  score?: EndpointScore;
}
function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]!;
}
export function summarizeEndpointCorpus(corpus: TurnCorpus, cases: EndpointCaseResult[]) {
  const measured = cases.filter(item => item.status === 'measured' && item.physicalChineseEvidence && item.score && item.score.outcome !== 'unannotated');
  const turns = measured.filter(item => ['on_time', 'premature', 'late', 'missed'].includes(item.score!.outcome));
  const negatives = measured.filter(item => ['correct_rejection', 'false_endpoint'].includes(item.score!.outcome));
  const count = (outcome: EndpointOutcome) => measured.filter(item => item.score!.outcome === outcome).length;
  const latencies = turns.flatMap(item => item.score!.latencyMs !== null && item.score!.latencyMs >= 0 ? [item.score!.latencyMs] : []);
  const metrics = { turnCases: turns.length, noEndpointCases: negatives.length,
    premature: count('premature'), missed: count('missed'), late: count('late'), falseEndpoints: count('false_endpoint'),
    prematureRate: turns.length ? count('premature') / turns.length : null,
    missedEndpointRate: turns.length ? (count('missed') + count('late')) / turns.length : null,
    falseEndpointRate: negatives.length ? count('false_endpoint') / negatives.length : null,
    latencyP50Ms: percentile(latencies, 0.5), latencyP95Ms: percentile(latencies, 0.95) };
  const reasons: string[] = [];
  for (const item of cases) if (item.status === 'error') reasons.push(`case_runtime_error:${item.id}`);
  for (const item of corpus.recordings) {
    if (item.status === 'available' && item.endpoint && !cases.some(result => result.id === item.id && result.status === 'measured')) reasons.push(`labeled_case_unmeasured:${item.id}`);
  }
  for (const id of corpus.endpointEvaluation.requiredIds) {
    const item = cases.find(result => result.id === id);
    if (!item || item.status !== 'measured' || !item.score || item.score.outcome === 'unannotated') reasons.push(`required_case_unmeasured:${id}`);
    if (!item?.physicalChineseEvidence) reasons.push(`physical_chinese_evidence_missing:${id}`);
  }
  const targets = corpus.endpointEvaluation.thresholds;
  if (!targets) reasons.push('thresholds_not_configured');
  else if (metrics.prematureRate === null || metrics.missedEndpointRate === null || metrics.latencyP95Ms === null
    || targets.maxFalseEndpointRate !== undefined && metrics.falseEndpointRate === null) reasons.push('insufficient_metric_coverage');
  const exceeded: string[] = [];
  if (targets) {
    if (metrics.prematureRate !== null && metrics.prematureRate > targets.maxPrematureRate) exceeded.push('premature_rate');
    if (metrics.missedEndpointRate !== null && metrics.missedEndpointRate > targets.maxMissedRate) exceeded.push('missed_endpoint_rate');
    if (metrics.latencyP95Ms !== null && metrics.latencyP95Ms > targets.maxP95LatencyMs) exceeded.push('latency_p95');
    if (targets.maxFalseEndpointRate !== undefined && metrics.falseEndpointRate !== null && metrics.falseEndpointRate > targets.maxFalseEndpointRate) exceeded.push('false_endpoint_rate');
  }
  return { metricsScope: 'consented_target_device_chinese', metrics, assessment: { status: reasons.length ? 'blocked' : exceeded.length ? 'thresholds_failed' : 'criteria_met', reasons, exceeded,
    manualReviewRequired: true, enablesAutoEndpoint: false, certifiesAec: false } };
}
