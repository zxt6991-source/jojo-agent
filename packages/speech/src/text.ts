import { SPEECH_LIMITS } from '@desktop-agent/contracts';

/** Deterministic normalization; source messages remain untouched. */
export function normalizeSpeechTextContent(text: string): string {
  return text.normalize('NFC')
    .replace(/```[^\n]*\n?[\s\S]*?```/gu, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/https?:\/\/[^\s<>]+/gu, ' ')
    .replace(/^\s*\|.*\|\s*$/gmu, ' ')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gmu, '')
    .replace(/[*_`~]/gu, '')
    .replace(/\s+/gu, ' ').trim();
}

export function normalizeSpeechText(text: string, maxChars: number = SPEECH_LIMITS.autoReadChars): string {
  if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 10_000) throw new Error('Invalid speech text limit.');
  return Array.from(normalizeSpeechTextContent(text)).slice(0, maxChars).join('');
}
