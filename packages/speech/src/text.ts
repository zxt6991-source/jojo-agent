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

/** Keep continuation offsets in Unicode code points. Prefer a complete sentence,
 * then a clause or word boundary, without losing separators between segments. */
export function speechTextSegment(text: readonly string[], offset: number, maxChars: number): string {
  const end = Math.min(text.length, offset + maxChars);
  if (end === text.length) return text.slice(offset, end).join('');
  const minimum = offset + Math.ceil(maxChars * 0.6);
  for (let index = end - 1; index >= minimum; index--) {
    if (/[。！？!?；;]/u.test(text[index]!) || (text[index] === '.' && /\s/u.test(text[index + 1]!))) return text.slice(offset, index + 1).join('');
  }
  for (let index = end - 1; index >= minimum; index--) {
    if (/[，,：:\s]/u.test(text[index]!)) return text.slice(offset, index + 1).join('');
  }
  return text.slice(offset, end).join('');
}
