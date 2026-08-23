export type CandidateToolEventSummary = {
  toolName: string;
  ok: boolean;
  summary: string;
  external: boolean;
};

export type CandidateRuntimeSignals = {
  hadUserCorrection: boolean;
  hadRepeatedFailure: boolean;
  hadMilestone: boolean;
  hadExplicitMemoryIntent: boolean;
  hadDesignDecision: boolean;
  hadValidatedLesson: boolean;
  externalOnly: boolean;
  transientOnly: boolean;
};

export type CandidateEligibility = {
  eligible: boolean;
  score: number;
  signals: CandidateRuntimeSignals;
  reasons: string[];
};

const EXPLICIT_MEMORY = /(?:记住|记下来|以后(?:都|请|要)|下次(?:不要|记得)|长期(?:记忆|保存)|remember (?:this|that)|from now on|going forward|next time)/iu;
const CORRECTION = /(?:不是.{0,40}(?:而?是|要用)|别再|不能自动|纠正|更正|actually[,，:]?|not .{0,40}(?:but|use)|don't use|do not use)/iu;
const DESIGN_DECISION = /(?:最终(?:选|决定|采用)|决定(?:使用|采用)|选用|不用.{0,50}(?:改用|而用)|取舍|design decision|decided to|chose .{0,50} instead of|use .{0,50} rather than)/iu;
const MILESTONE = /(?:已完成|完成了|下一阶段|里程碑|milestone|completed|shipped|next phase)/iu;
const TRANSIENT = /(?:临时|一次性|先调试|debug 输出|debug output|one[- ]off|temporary|just this once|格式(?:化|修改)|网页摘要|web summary)/iu;
const VALIDATED = /(?:已验证|验证通过|测试通过|根因|原因是|修复后|confirmed|verified|tests? pass|root cause|fixed by)/iu;

export function evaluateCandidateEligibility(input: {
  userText: string;
  assistantText?: string;
  toolEvents: CandidateToolEventSummary[];
  minScore: number;
}): CandidateEligibility {
  const combined = `${input.userText}\n${input.assistantText ?? ''}`;
  const failureCounts = new Map<string, number>();
  for (const event of input.toolEvents) {
    if (!event.ok) failureCounts.set(event.toolName, (failureCounts.get(event.toolName) ?? 0) + 1);
  }
  const signals: CandidateRuntimeSignals = {
    hadExplicitMemoryIntent: EXPLICIT_MEMORY.test(input.userText),
    hadUserCorrection: CORRECTION.test(input.userText),
    hadDesignDecision: DESIGN_DECISION.test(combined),
    hadMilestone: MILESTONE.test(combined),
    hadRepeatedFailure: [...failureCounts.values()].some((count) => count >= 2),
    hadValidatedLesson: VALIDATED.test(input.assistantText ?? '') && input.toolEvents.some((event) => event.ok),
    externalOnly: input.toolEvents.length > 0
      && input.toolEvents.every((event) => event.external)
      && !EXPLICIT_MEMORY.test(input.userText)
      && !CORRECTION.test(input.userText)
      && !DESIGN_DECISION.test(input.userText),
    transientOnly: TRANSIENT.test(combined)
      && !EXPLICIT_MEMORY.test(input.userText)
      && !CORRECTION.test(input.userText)
      && !DESIGN_DECISION.test(input.userText)
  };
  const score = (signals.hadExplicitMemoryIntent ? 100 : 0)
    + (signals.hadUserCorrection ? 40 : 0)
    + (signals.hadDesignDecision ? 30 : 0)
    + (signals.hadValidatedLesson ? 30 : 0)
    + (signals.hadMilestone ? 20 : 0)
    + (signals.hadRepeatedFailure ? 15 : 0)
    - (signals.externalOnly ? 50 : 0)
    - (signals.transientOnly ? 40 : 0);
  const reasons = Object.entries(signals).filter(([, matched]) => matched).map(([name]) => name);
  return { eligible: score >= input.minScore, score, signals, reasons };
}
