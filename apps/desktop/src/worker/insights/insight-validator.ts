import { z } from 'zod';
import { InsightCardSchema, type EvolutionEvent, type InsightAnalysisPerspective, type InsightCard, type MessageReference } from '@desktop-agent/contracts';
import { isSecondOrderEvent, isSecondOrderInquiry } from './strategies/registry';

const nonblank = (max: number) => z.string().trim().min(1).max(max);
// A model can nominate event IDs, never construct authoritative message references.
export const InsightModelCardSchema = z.object({
  title: nonblank(140), explanation: nonblank(1000),
  nature: z.enum(['model_inference', 'hypothesis', 'suggestion']),
  uncertainty: nonblank(500), verificationQuestion: nonblank(500),
  supportingEventIds: z.array(nonblank(256)).min(1).max(10),
  // Internal grounding only; authoritative message references remain program mapped.
  scenarioEvidence: z.object({ eventId: nonblank(256), exactQuote: nonblank(120) }).strict().optional()
}).strict();
export const InsightModelOutputSchema = z.object({ cards: z.array(InsightModelCardSchema).max(20) }).strict();
const referenceKey = (ref: MessageReference) => JSON.stringify([ref.sessionId, ref.entryId]);

export function validateInsightCards(value: unknown, events: EvolutionEvent[], perspective: InsightAnalysisPerspective): { cards: InsightCard[]; omittedCardCount: number } {
  const envelope = z.object({ cards: z.array(z.unknown()).max(20) }).strict().parse(value);
  const byId = new Map(events.map(event => [event.id, event]));
  const cards: InsightCard[] = [];
  for (const raw of envelope.cards) {
    const parsed = InsightModelCardSchema.safeParse(raw);
    if (!parsed.success) continue;
    const candidate = parsed.data;
    if (new Set(candidate.supportingEventIds).size !== candidate.supportingEventIds.length) continue;
    const supporting = candidate.supportingEventIds.map(id => byId.get(id));
    if (supporting.some(event => !event || event.speaker !== 'user')) continue;
    const sources = supporting as EvolutionEvent[];
    const { scenarioEvidence, ...publicCandidate } = candidate;
    if (scenarioEvidence) {
      const scenarioSource = sources.find(event => event.id === scenarioEvidence.eventId);
      if (perspective !== 'second_order' || !scenarioSource || !isSecondOrderInquiry(scenarioSource)
        || !scenarioSource.evidence.some(item => item.reference.role === 'user' && item.quote.includes(scenarioEvidence.exactQuote))) continue;
      if (!sources.some(isSecondOrderEvent) && sources.some(event => event.topicId !== scenarioSource.topicId)) continue;
    }
    if (perspective === 'reverse_thinking' && (candidate.nature !== 'hypothesis' || !sources.some(event => ['decision', 'revision', 'position', 'constraint'].includes(event.eventType)))) continue;
    if (perspective === 'second_order' && (candidate.nature !== 'hypothesis' || (!sources.some(isSecondOrderEvent) && !scenarioEvidence))) continue;
    if (perspective === 'blind_spots' && (candidate.nature === 'hypothesis' || new Set(sources.map(event => event.topicId)).size !== 1)) continue;
    const allText = [candidate.title, candidate.explanation, candidate.uncertainty, candidate.verificationQuestion].join('\n');
    // These views must not produce fixed personality or clinical labels.
    if (/\b(?:MBTI|INTJ|INTP|INFJ|INFP|ENTJ|ENTP|ENFJ|ENFP|ISTJ|ISFJ|ISTP|ISFP|ESTJ|ESFJ|ESTP|ESFP|CBT)\b|人格障碍|人格类型|心理诊断|你(?:是|有|属于).{0,8}(?:抑郁症|焦虑症|人格)/iu.test(allText)) continue;
    // These are newly proposed consequences, never reports of historical outcomes.
    // Discard overconfident output instead of laundering it with a "possible" prefix.
    if (perspective === 'second_order' && /已经|已(?:实现|导致|造成|发生|达成|获得|完成|证明)|必然|必定|必将|一定(?:会|导致|造成)|确定(?:导致|造成|会)|肯定会|保证(?:会|能够)|毫无疑问|\b(?:guaranteed|certainly|definitely|inevitably|has resulted|have resulted|already achieved|already caused|will certainly)\b/iu.test(allText)) continue;
    if (perspective === 'blind_spots' && /你(?:们)?(?:从未|从来没|没有(?:考虑|意识|能力)|缺乏|总是|就是)|用户(?:从未|从来没|缺乏|没有考虑)|\b(?:you (?:have )?never|you lack|your personality)\b/iu.test(allText)) continue;
    const prefix = perspective === 'blind_spots' ? '依据本次可核验的记录，仍值得补充确认：'
      : perspective === 'second_order' ? scenarioEvidence ? `假如选择用户提问中「${scenarioEvidence.exactQuote}」所指的方案，可能的影响路径（尚未验证）：`
        : sources.some(event => event.state === 'decided') ? '可能的影响路径（尚未验证）：' : '假如选择该方案，可能的影响路径（尚未验证）：'
        : '反向假设（尚未验证）：';
    const references = [...new Map(sources.flatMap(event => event.evidence).map(item => [referenceKey(item.reference), item.reference])).values()];
    const card = InsightCardSchema.safeParse({
      ...publicCandidate, id: `insight-${cards.length + 1}`, topicId: sources[0]!.topicId,
      explanation: `${prefix}${candidate.nature === 'model_inference' ? '可能存在以下线索：' : ''}${candidate.explanation}`,
      uncertainty: `${candidate.uncertainty}${scenarioEvidence ? ' 此推演以提问中的备选方案为条件，原文不能确定用户是否作出决定或执行。' : ''}${sources.some(event => event.truncatedSource) ? ' 原文曾被截断，仅依据已读取片段。' : ''}`,
      supportingReferences: references
    });
    if (card.success) cards.push(card.data);
  }
  return { cards, omittedCardCount: envelope.cards.length - cards.length };
}
