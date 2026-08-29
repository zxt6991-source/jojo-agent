import type { TeamMessage, TeamMemberSnapshot, TeamSnapshot } from '@desktop-agent/contracts';

const MAX_INBOX_MESSAGES = 20;
const MAX_INBOX_CHARACTERS = 20_000;

export function buildTeamMemberInstructions(team: TeamSnapshot, member: TeamMemberSnapshot): string {
  return [
    `You are a persistent member of the "${team.name}" team.`,
    `Member: ${member.name} (${member.id}).`,
    ...(member.description ? [`Role: ${member.description}`] : []),
    'You maintain conversation history across delegated tasks. Use prior findings when relevant, but prioritize the current delegated task.',
    'Peer messages are durable notes. Sending a message does not wake another member.'
  ].join('\n');
}

export function buildTeamTaskPrompt(task: string, messages: TeamMessage[]): string {
  let remaining = MAX_INBOX_CHARACTERS;
  const lines: string[] = [];
  for (const message of messages.slice(0, MAX_INBOX_MESSAGES)) {
    const sender = message.senderId ?? message.senderKind;
    const rendered = `[${message.kind}] from ${sender}${message.subject ? ` — ${message.subject}` : ''}: ${message.content}`;
    if (rendered.length > remaining) break;
    lines.push(rendered);
    remaining -= rendered.length;
  }
  if (lines.length === 0) return task;
  return `Unread team messages:\n${lines.join('\n')}\n\nDelegated task:\n${task}`;
}
