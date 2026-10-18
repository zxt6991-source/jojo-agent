/** A projection of public assistant text only. Tool arguments and reasoning
 * must never be passed here. Incomplete Markdown stays buffered across deltas. */
export interface VoiceTextPhrase { text: string; sourceTextRange: { start: number; end: number } }

export function oralText(text: string): string {
  if (/\|.*\|/u.test(text) || /^\s*(?:\|.*\||[+-]{3}|@@|diff --git|Traceback|at \S+\s*\(|[{}[\]])/u.test(text)) return '';
  return text.normalize('NFC')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/`+[^`]*`+/gu, ' ')
    .replace(/(?:https?:\/\/|www\.)[^\s<>，。！？；]+/gu, ' ')
    .replace(/\b(?=[^\s，。！？]*[A-Za-z_])(?:[\w@.-]+\/)+[\w@.-]+\b/gu, ' ')
    .replace(/(?:[A-Za-z]:[\\/]|(?<![\w.])(?:~|\.{1,2})?\/)[\w./\\@%+~:-]+/gu, ' ')
    .replace(/\b[\w.-]+\.(?:ts|tsx|js|jsx|json|py|md|yaml|yml|toml|log|sh|patch)\b/giu, ' ')
    .replace(/\b[a-f\d]{16,}\b/giu, ' ')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/u, '')
    .replace(/(^|\s)[/\\]+(?=\s|$)/gu, '$1').replace(/[*_~]/gu, '').replace(/\s+/gu, ' ').trim();
}

export class VoiceTextProjector {
  private pending = '';
  private offset = 0;
  private total = 0;
  private fence: string | undefined;
  private finished = false;
  private diff = false;
  private structuredDepth = 0;
  private structuredString = false;
  private structuredEscape = false;
  constructor(private readonly maxSourceChars = 100_000) {}

  append(delta: string): VoiceTextPhrase[] {
    if (this.finished) throw new Error('voice_projection_finished');
    this.total += delta.length;
    if (this.total > this.maxSourceChars) throw new Error('voice_projection_limit');
    this.pending += delta;
    return this.drain(false);
  }
  finish(): VoiceTextPhrase[] {
    if (this.finished) return [];
    this.finished = true;
    return this.drain(true);
  }
  /** The first-chunk deadline may release a weak oral boundary, but never an
   * unfinished Markdown construct, URL, path, number or date token. */
  flushWeakBoundary(): VoiceTextPhrase[] {
    if (this.finished || this.fence || this.diff || this.structuredDepth || /^\s*(?:[`~]|[[{}|])/u.test(this.pending)) return [];
    let inline = false, depth = 0, boundary = -1;
    for (let i = 0; i < Math.min(this.pending.length, 180); i++) {
      const char = this.pending[i]!;
      if (char === '\n') break;
      if (char === '`') inline = !inline;
      if (inline) continue;
      if (char === '[' || char === '(') depth++;
      if (char === ']' || char === ')') depth = Math.max(0, depth - 1);
      if (depth || /\d/u.test(this.pending[i - 1] ?? '') && /\d/u.test(this.pending[i + 1] ?? '')) continue;
      if (/[，、,：]/u.test(char)) boundary = i;
    }
    if (boundary < 8) return [];
    const raw = this.pending.slice(0, boundary + 1);
    const text = oralText(raw), start = this.offset;
    if (Array.from(text).length < 8) return [];
    this.consume(boundary + 1);
    return [{ text, sourceTextRange: { start, end: this.offset } }];
  }
  private drain(final: boolean): VoiceTextPhrase[] {
    const phrases: VoiceTextPhrase[] = [];
    while (this.pending) {
      const newline = this.pending.indexOf('\n');
      if (this.structuredDepth || /^\s*(?:\{|\[(?:\s*$|\s*[[{"\d]))/u.test(this.pending)) {
        if (newline < 0 && !final) break;
        const end = newline < 0 ? this.pending.length : newline + 1;
        for (const char of this.pending.slice(0, end)) {
          if (this.structuredEscape) { this.structuredEscape = false; continue; }
          if (char === '\\' && this.structuredString) { this.structuredEscape = true; continue; }
          if (char === '"') this.structuredString = !this.structuredString;
          if (!this.structuredString) {
            if (char === '{' || char === '[') this.structuredDepth++;
            if (char === '}' || char === ']') this.structuredDepth = Math.max(0, this.structuredDepth - 1);
          }
        }
        this.consume(end); continue;
      }
      if (this.diff || /^(?:diff --git|@@|--- [ab]\/)/u.test(this.pending)) {
        if (newline < 0 && !final) break;
        const end = newline < 0 ? this.pending.length : newline + 1;
        const line = this.pending.slice(0, end);
        if (/^(?:diff --git|index |@@|--- |\+\+\+ |[+\- ]|\\ No newline)/u.test(line)) { this.diff = true; this.consume(end); continue; }
        this.diff = false;
      }
      const opener = /^\s{0,3}(`{3,}|~{3,})/u.exec(this.pending);
      if (this.fence || opener) {
        if (newline < 0 && !final) break;
        const end = newline < 0 ? this.pending.length : newline + 1;
        if (!this.fence && opener) this.fence = opener[1]!;
        else if (this.fence && new RegExp(`^\\s{0,3}${this.fence[0]}{${this.fence.length},}\\s*$`, 'u').test(this.pending.slice(0, end).trimEnd())) this.fence = undefined;
        this.consume(end); continue;
      }
      let inline = false, bracketDepth = 0, parenDepth = 0, end = 0;
      for (let index = 0; index < this.pending.length; index++) {
        const char = this.pending[index]!;
        if (char === '\n') { end = index + 1; break; }
        if (char === '`') inline = !inline;
        if (inline) continue;
        if (char === '[') bracketDepth++;
        if (char === ']') bracketDepth = Math.max(0, bracketDepth - 1);
        if (char === '(') parenDepth++;
        if (char === ')') parenDepth = Math.max(0, parenDepth - 1);
        if (bracketDepth || parenDepth) continue;
        if (/[。！？；!?;]/u.test(char) || (char === '.' && /\s/u.test(this.pending[index + 1] ?? ''))) { end = index + 1; break; }
      }
      if (!end) {
        if (!final) break;
        // An unfinished inline/link construct cannot be safely spoken.
        if (inline || bracketDepth || parenDepth) { this.consume(this.pending.length); break; }
        end = this.pending.length;
      }
      const raw = this.pending.slice(0, end);
      const text = oralText(raw);
      const start = this.offset;
      this.consume(end);
      if (text && /[\p{L}\p{N}]/u.test(text)) phrases.push({ text, sourceTextRange: { start, end: this.offset } });
    }
    return phrases;
  }
  private consume(length: number): void { this.pending = this.pending.slice(length); this.offset += length; }
}

/** Automatic reading is intentionally short; manual reading keeps its own
 * complete-message projection and continuation offsets. */
export function projectVoiceReply(text: string, maxChars = 180): string {
  const projector = new VoiceTextProjector();
  const phrases = [...projector.append(text), ...projector.finish()];
  const result: string[] = [];
  let length = 0;
  for (const phrase of phrases) {
    if (result.length >= 2) break;
    const chars = Array.from(phrase.text);
    if (length + chars.length > maxChars) break;
    result.push(phrase.text); length += chars.length;
  }
  return result.join(' ') || (text.trim() ? '结果已经放在屏幕上了，请查看具体内容。' : '');
}
