import type { Message, ProjectIdentity } from '@desktop-agent/contracts';
import { scanSecrets } from '../security/secret-scanner.js';
import { truncateToTokens } from '../snapshot/budget.js';
import type { CandidateToolEventSummary } from './eligibility.js';

export type MemoryCandidateEvidence = {
  userRequest: string;
  userCorrections: string[];
  finalOutcome?: string;
  explicitDecisions: string[];
  validatedToolFacts: Array<{ toolName: string; summary: string }>;
  memoryMutations: Array<{ action: 'write' | 'forget' | 'restore'; entryId?: string }>;
  externalContentPresent: boolean;
  projectIdentity?: { id: string; displayName: string };
};

const EXTERNAL_TOOLS = /^(?:web_|browser_|mcp_|fetch|search)/iu;

export function redactCandidateText(value: string): string {
  const lines = value.replaceAll('\0', '').split('\n');
  const secretLines = new Set(scanSecrets(value).map((finding) => finding.line - 1));
  return lines.map((line, index) => secretLines.has(index) ? '[REDACTED SECRET]' : line)
    .join('\n').trim();
}

function plainText(message: Message): string {
  return message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
}

export function summarizeTurnTools(messages: Message[], userText: string): CandidateToolEventSummary[] {
  let start = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === 'user' && plainText(message).includes(userText)) { start = index; break; }
  }
  const turn = messages.slice(Math.max(0, start));
  const calls = new Map<string, string>();
  for (const message of turn) for (const block of message.content) {
    if (block.type === 'tool_call') calls.set(block.call.id, block.call.name);
  }
  const events: CandidateToolEventSummary[] = [];
  for (const message of turn) for (const block of message.content) {
    if (block.type !== 'tool_result') continue;
    const toolName = calls.get(block.result.callId) ?? 'unknown';
    const external = EXTERNAL_TOOLS.test(toolName);
    const safeSummary = external
      ? `${block.result.ok ? 'External tool completed' : 'External tool failed'}${block.result.code ? ` (${block.result.code})` : ''}.`
      : redactCandidateText(block.result.content).replace(/\s+/gu, ' ').slice(0, 240);
    events.push({ toolName, ok: block.result.ok, summary: safeSummary, external });
  }
  return events;
}

export function buildCandidateEvidence(input: {
  userText: string;
  assistantText?: string;
  toolEvents: CandidateToolEventSummary[];
  projectIdentity?: ProjectIdentity;
  evidenceMaxTokens: number;
  hadCorrection: boolean;
  hadDecision: boolean;
}): MemoryCandidateEvidence {
  const limit = (value: string, tokens: number) => truncateToTokens(redactCandidateText(value), tokens);
  const memoryMutations = input.toolEvents.flatMap((event) => {
    const action = event.toolName === 'memory_write' ? 'write'
      : event.toolName === 'memory_forget' ? 'forget'
        : event.toolName === 'memory_restore' ? 'restore' : undefined;
    return action ? [{ action }] : [];
  }) as MemoryCandidateEvidence['memoryMutations'];
  const budget = input.evidenceMaxTokens;
  return {
    userRequest: limit(input.userText, Math.floor(budget * 0.4)),
    userCorrections: input.hadCorrection ? [limit(input.userText, Math.floor(budget * 0.25))] : [],
    ...(input.assistantText ? { finalOutcome: limit(input.assistantText, Math.floor(budget * 0.3)) } : {}),
    explicitDecisions: input.hadDecision ? [limit(`${input.userText}\n${input.assistantText ?? ''}`, Math.floor(budget * 0.25))] : [],
    validatedToolFacts: input.toolEvents.filter((event) => event.ok && !event.external).slice(0, 8)
      .map((event) => ({ toolName: event.toolName, summary: limit(event.summary, 80) })),
    memoryMutations,
    externalContentPresent: input.toolEvents.some((event) => event.external),
    ...(input.projectIdentity ? { projectIdentity: { id: input.projectIdentity.id, displayName: input.projectIdentity.displayName } } : {})
  };
}
