import { describe, expect, it } from 'vitest';
import manifest from '../../../tests/fixtures/speech/manifest.json';
import { parseTurnCorpus, scoreEndpoint, summarizeEndpointCorpus, type EndpointAnnotation, type EndpointCaseResult } from '../src/turn-evaluation';

const hash = 'a'.repeat(64);
const turn: EndpointAnnotation = { kind: 'turn', audioSha256: hash, speechEndMs: 1000, maxLatencyMs: 500 };
function fixture() {
  return { version: 1, endpointEvaluation: { requiredIds: ['question'], thresholds: { maxPrematureRate: 0, maxMissedRate: 0, maxP95LatencyMs: 500 } },
    recordings: [{ id: 'question', wav: 'question.wav', status: 'available', provenance: 'target_device_recording', consentConfirmed: true,
      environmentId: 'mac-internal', language: 'zh', endpoint: { ...turn } }] };
}
describe('Chinese endpoint labels and metrics', () => {
  it('reports the real 13 missing recordings and six endpoint scenarios without inventing rates or targets', () => {
    const corpus = parseTurnCorpus(manifest);
    expect(corpus.recordings).toHaveLength(13);
    expect(corpus.endpointEvaluation.requiredIds).toHaveLength(6);
    const summary = summarizeEndpointCorpus(corpus, corpus.recordings.map(item => ({ id: item.id, status: 'missing', issues: [], physicalChineseEvidence: false })));
    expect(summary.metrics).toMatchObject({ turnCases: 0, prematureRate: null, missedEndpointRate: null, latencyP95Ms: null });
    expect(summary.assessment).toMatchObject({ status: 'blocked', enablesAutoEndpoint: false, certifiesAec: false });
    expect(summary.assessment.reasons).toContain('thresholds_not_configured');
  });
  it.each([
    [999, 'premature', -1], [1000, 'on_time', 0], [1500, 'on_time', 500], [1501, 'late', 501], [null, 'missed', null]
  ] as const)('scores endpoint %s on the audio replay clock', (at, outcome, latencyMs) => {
    expect(scoreEndpoint(turn, 2000, at)).toEqual({ outcome, latencyMs });
  });
  it('distinguishes silence rejection and false endpoints, and never scores an unlabeled reference', () => {
    expect(scoreEndpoint({ kind: 'no_endpoint', audioSha256: hash }, 2000, null).outcome).toBe('correct_rejection');
    expect(scoreEndpoint({ kind: 'no_endpoint', audioSha256: hash }, 2000, 300).outcome).toBe('false_endpoint');
    expect(scoreEndpoint(undefined, 2000, 300)).toEqual({ outcome: 'unannotated', latencyMs: null });
    expect(() => scoreEndpoint(turn, 1499, null)).toThrow('insufficient_labeled_audio');
    expect(() => scoreEndpoint(turn, 2000, Number.NaN)).toThrow('invalid_endpoint_observation');
  });
  it('uses explicit denominators, counts late endpoints as missed deadlines and retains negative latency per case', () => {
    const corpus = parseTurnCorpus(fixture());
    const outcomes = [scoreEndpoint(turn, 2000, 900), scoreEndpoint(turn, 2000, null), scoreEndpoint(turn, 2000, 1600), scoreEndpoint(turn, 2000, 1100)];
    const results: EndpointCaseResult[] = outcomes.map((score, index) => ({ id: index ? `q${index}` : 'question', status: 'measured', issues: [], physicalChineseEvidence: true, score }));
    results.push({ id: 'noise', status: 'measured', issues: [], physicalChineseEvidence: true, score: { outcome: 'false_endpoint', latencyMs: null } });
    const { metrics, assessment } = summarizeEndpointCorpus(corpus, results);
    expect(metrics).toMatchObject({ turnCases: 4, prematureRate: 0.25, missedEndpointRate: 0.5, falseEndpointRate: 1, latencyP50Ms: 100, latencyP95Ms: 600 });
    expect(assessment).toMatchObject({ status: 'thresholds_failed', exceeded: ['premature_rate', 'missed_endpoint_rate', 'latency_p95'], enablesAutoEndpoint: false });
  });
  it('does not let reference or synthetic clips dilute physical error rates or satisfy required evidence', () => {
    const corpus = parseTurnCorpus(fixture());
    const reference: EndpointCaseResult = { id: 'question', status: 'measured', issues: [], physicalChineseEvidence: false, score: { outcome: 'on_time', latencyMs: 100 } };
    const report = summarizeEndpointCorpus(corpus, [reference]);
    expect(report.metrics.turnCases).toBe(0);
    expect(report.assessment.reasons).toContain('physical_chinese_evidence_missing:question');
    expect(report.assessment.status).toBe('blocked');
    const physical = { ...reference, physicalChineseEvidence: true, score: { outcome: 'premature' as const, latencyMs: -10 } };
    expect(summarizeEndpointCorpus(corpus, [physical, { ...reference, id: 'synthetic' }]).metrics.prematureRate).toBe(1);
  });
  it('requires human review even when explicit criteria are met, and blocks runtime failures', () => {
    const corpus = parseTurnCorpus(fixture());
    const result: EndpointCaseResult = { id: 'question', status: 'measured', issues: [], physicalChineseEvidence: true, score: { outcome: 'on_time', latencyMs: 300 } };
    expect(summarizeEndpointCorpus(corpus, [result]).assessment).toMatchObject({ status: 'criteria_met', manualReviewRequired: true, enablesAutoEndpoint: false, certifiesAec: false });
    expect(summarizeEndpointCorpus(corpus, [result, { id: 'failed', status: 'error', issues: [], physicalChineseEvidence: true }]).assessment.status).toBe('blocked');
  });
  it.each(['../private.wav', '/private.wav', 'nested/../private.wav', 'nested//file.wav', 'file.mp3', 'file\u0000.wav'])('rejects escaping or invalid WAV path %s', wav => {
    const input = fixture(); input.recordings[0]!.wav = wav;
    expect(() => parseTurnCorpus(input)).toThrow('invalid_turn_recording');
  });
  it('accepts local Chinese filenames and blocks a skipped optional labeled recording', () => {
    const input = fixture(); input.recordings[0]!.wav = '中文录音/正常提问.WAV';
    input.recordings.push({ ...input.recordings[0]!, id: 'optional' });
    const corpus = parseTurnCorpus(input);
    const report = summarizeEndpointCorpus(corpus, [{ id: 'question', status: 'measured', issues: [], physicalChineseEvidence: true, score: { outcome: 'on_time', latencyMs: 100 } },
      { id: 'optional', status: 'blocked', issues: ['annotation_audio_mismatch'], physicalChineseEvidence: true }]);
    expect(report.assessment.status).toBe('blocked');
    expect(report.assessment.reasons).toContain('labeled_case_unmeasured:optional');
  });
  it('rejects duplicate identities, wrong hashes, nonfinite labels, missing requirements and invalid targets', () => {
    const duplicate = fixture(); duplicate.recordings.push(duplicate.recordings[0]!);
    const badHash = fixture(); badHash.recordings[0]!.endpoint.audioSha256 = 'label-from-another-file';
    const invalidTime = fixture(); (invalidTime.recordings[0]!.endpoint as { speechEndMs: number }).speechEndMs = Number.NaN;
    const invalidTarget = fixture(); invalidTarget.endpointEvaluation.thresholds.maxPrematureRate = -1;
    const absent = fixture(); absent.endpointEvaluation.requiredIds = ['unknown'];
    for (const value of [duplicate, badHash, invalidTime, invalidTarget, absent]) expect(() => parseTurnCorpus(value)).toThrow();
  });
});
