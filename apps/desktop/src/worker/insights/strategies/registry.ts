import type { EvolutionEvent, InsightAnalysisPerspective } from '@desktop-agent/contracts';

export interface InsightStrategy {
  id: InsightAnalysisPerspective;
  promptVersion: string;
  instructions: string;
  selectEvents(events: EvolutionEvent[]): EvolutionEvent[];
}

const users = (events: EvolutionEvent[]) => events.filter(event => event.speaker === 'user');
const trivialInquiry = /^(?:你好|您好|嗨|哈[啰喽]|hello|hi|hey|谢谢|感谢|多谢|thankyou|thanks|好|好的|嗯|嗯嗯|哦|哦哦|是|是的|对|对的|没错|可以|行|ok|okay|收到|明白|了解|继续|开始|执行|再试|重试|试试)$/iu;
const isTrivialInquiry = (event: EvolutionEvent) => event.evidence.every(item => trivialInquiry.test(item.quote.normalize('NFKC').replace(/[\s\p{P}]/gu, '')));
const reverseThinking: InsightStrategy = {
  id: 'reverse_thinking', promptVersion: 'reverse-v2',
  instructions: '识别用户明确观点、约束、决定或改选里的可证实假设，逐条提出可信的反面条件、可能的失败机制以及最低成本检验问题。nature 必须为 hypothesis。每条至少引用一个用户 decision、revision、position 或 constraint。revision 只依据已验证的改选原文，不推断缺失的旧方案或改变动机。随意提问不构成核心假设。反面条件仅是假设，不能写成已经发生的事实。',
  selectEvents: events => users(events).filter(event => ['decision', 'revision', 'position', 'constraint'].includes(event.eventType))
};
const secondOrder: InsightStrategy = {
  id: 'second_order', promptVersion: 'second-order-v3',
  instructions: '从用户明确方案、决定、改选，或具体提问中点名的备选方案推演可能影响。nature 必须为 hypothesis。revision 仅依据已验证的改选原文，不推断缺失的旧方案、改变动机或实施状态。exploration/open_question 可以是条件推演的起点，但提问不等于用户作出决定或执行行动。若 supportingEventIds 中没有 decision/revision/option 或 planned/decided 状态的用户事件，必须提供 scenarioEvidence:{eventId,exactQuote}：eventId 必须是 supportingEventIds 中的用户 exploration/open_question，exactQuote 必须逐字复制该事件 evidence.quote 中点名具体备选方案或行动的连续片段（最多120字），不得引用 claim 中的概括或 AI 建议；此类卡片只引用与该提问相同主题的用户事件。例如“有没有适合长期持有的债基”可用“长期持有的债基”作为假设对象，不能据此认定用户已持有；“看看最近的运动情况”等概况或纯事实提问没有具体备选行动时返回 {"cards":[]}，不得自行发明改变策略或执行方案。有明确选择事件时可省略 scenarioEvidence；若提供仍必须满足上述原文要求。explanation 按“可能的直接影响 → 随后可能的二阶影响”描述，说明受影响对象；uncertainty 写关键依赖条件和不确定性。输入仅为本次提供的用户事件片段，不代表完整聊天或全部已知信息；信息不足只能表述为“本次提供的片段无法确认”，不得断言整个历史、完整对话或用户从未提供或讨论某项信息。未确定选择时必须使用“假如选择该方案”，不能断言用户已经决定，也不能断言用户尚未决定或执行。不得声称未来结果已经实现，不虚构真实因果链。verificationQuestion 提出能检验关键依赖的具体问题。',
  selectEvents: events => events.filter(event => isSecondOrderEvent(event) || isSecondOrderInquiry(event))
};

/** Selection and card support must agree, including verified changes of choice. */
export function isSecondOrderEvent(event: EvolutionEvent): boolean {
  return event.speaker === 'user' && (['decision', 'revision', 'option'].includes(event.eventType) || ['planned', 'decided'].includes(event.state));
}

/** Inquiry admission permits inspection; a grounded scenario is still required for a card. */
export function isSecondOrderInquiry(event: EvolutionEvent): boolean {
  return event.speaker === 'user' && ['exploration', 'open_question'].includes(event.eventType) && !isTrivialInquiry(event);
}
const blindSpots: InsightStrategy = {
  id: 'blind_spots', promptVersion: 'blind-spots-v3',
  instructions: '围绕用户明确提出的具体主题、问题或请求，发现选项、约束、利益相关方或证据之间尚待补充的信息，提出可操作的验证问题。用户提问或请求只是分析对象，绝不等于用户已持有某种观点、作出决定、选择方案或承诺行动；单条具体提问也可以提出有依据的补充问题，不要求多轮讨论。每张卡片只引用同一主题的用户事件。nature 为 suggestion 或 model_inference。信息缺口只限于本次提供的已分析片段，使用“仍值得补充确认”等建议措辞，不得声称整个所选聊天都未出现某项信息。结合相关 AI 上下文避免重复已有解释或建议，AI 已给出的说法仍不代表用户已接受或现实事实已核实。不能据此断言用户从未考虑、没有做过或缺乏能力，不能仅因用户没有提出某个问题就认定存在盲点。不要分析人格和心理特征。问候、确认、继续等指令，或没有具体分析对象、无法提出有价值验证问题的内容，输出空数组。',
  // A concrete inquiry is enough context for a clarification suggestion. Message
  // count and event type do not turn a question into a belief or a commitment.
  selectEvents: events => users(events).filter(event => !isTrivialInquiry(event))
};

const strategies: Record<InsightAnalysisPerspective, InsightStrategy> = {
  reverse_thinking: reverseThinking, second_order: secondOrder, blind_spots: blindSpots
};
export function insightStrategy(perspective: InsightAnalysisPerspective): InsightStrategy { return strategies[perspective]; }

/** The cache retains every candidate; only the perspective input has this budget. */
export function boundInsightEvents(events: EvolutionEvent[], maxEvents = 60, maxChars = 48_000): EvolutionEvent[] {
  const weights: Record<EvolutionEvent['eventType'], number> = { decision: 10, revision: 9, constraint: 8, position: 7, option: 6, action: 5, open_question: 3, exploration: 1 };
  const ranked = [...events].sort((a, b) => weights[b.eventType] - weights[a.eventType] || Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  const result: EvolutionEvent[] = [];
  let chars = 2;
  for (const event of ranked) {
    const size = JSON.stringify(event).length + 1;
    if (result.length >= maxEvents) break;
    if (chars + size > maxChars) continue;
    result.push(event); chars += size;
  }
  return result;
}
