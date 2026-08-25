import { realpath, stat } from 'node:fs/promises';
import type { BrowserFramePath } from '@desktop-agent/contracts';
import path from 'node:path';

export const MAX_BROWSER_UPLOAD_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_BROWSER_UPLOAD_TOTAL_BYTES = 100 * 1024 * 1024;
export const BROWSER_EVAL_MAX_JS_CHARS = 20_000;
export const BROWSER_EVAL_MAX_RESULT_CHARS = 64_000;
export const BROWSER_EVAL_TIMEOUT_MS = 8_000;

export function serializeBrowserEvalValue(value: unknown): { json: string; truncated: boolean } {
  let json: string;
  try {
    json = JSON.stringify(value === undefined ? null : value);
    if (typeof json !== 'string') json = JSON.stringify(String(value));
  } catch { json = JSON.stringify(String(value)); }
  if (json.length <= BROWSER_EVAL_MAX_RESULT_CHARS) return { json, truncated: false };
  return { json: `${json.slice(0, BROWSER_EVAL_MAX_RESULT_CHARS)}\n...[truncated]`, truncated: true };
}

export function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/u, '');
}

export function domainAllowsHost(rule: string, hostname: string): boolean {
  const normalizedRule = normalizeDomain(rule);
  const normalizedHost = normalizeDomain(hostname);
  if (!normalizedRule || !normalizedHost) return false;
  if (normalizedRule.startsWith('*.')) {
    const suffix = normalizedRule.slice(2);
    return normalizedHost !== suffix && normalizedHost.endsWith(`.${suffix}`);
  }
  return normalizedHost === normalizedRule;
}

export function isAllowedBrowserUrl(value: string, allowedDomains: Iterable<string>): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
  return [...allowedDomains].some((domain) => domainAllowsHost(domain, url.hostname));
}

export function assertBrowserUrl(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Browser URLs must use HTTP or HTTPS.');
  if (url.username || url.password) throw new Error('Browser URLs must not contain embedded credentials.');
  return url;
}

export function safeDownloadFilename(value: string): string {
  const base = [...path.basename(value).replace(/[<>:"/\\|?*]/gu, '_')]
    .map((character) => character.charCodeAt(0) < 32 ? '_' : character).join('').trim();
  if (!base || base === '.' || base === '..') return 'download';
  return base.slice(0, 180);
}

function isInsidePath(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export async function resolveBrowserUploadPaths(workingDirectory: string, requestedPaths: string[]): Promise<string[]> {
  const root = await realpath(path.resolve(workingDirectory));
  const resolved: string[] = [];
  let totalBytes = 0;
  for (const requestedPath of requestedPaths) {
    const target = await realpath(path.resolve(root, requestedPath));
    if (!isInsidePath(root, target)) throw new Error(`Browser uploads must stay inside the workspace: ${requestedPath}`);
    const info = await stat(target);
    if (!info.isFile()) throw new Error(`Browser upload target is not a regular file: ${requestedPath}`);
    if (info.size > MAX_BROWSER_UPLOAD_FILE_BYTES) throw new Error(`Browser upload file exceeds 50 MB: ${requestedPath}`);
    totalBytes += info.size;
    if (totalBytes > MAX_BROWSER_UPLOAD_TOTAL_BYTES) throw new Error('Browser upload files exceed the 100 MB total limit.');
    if (!resolved.includes(target)) resolved.push(target);
  }
  return resolved;
}

export type AccessibilityNode = {
  ignored?: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  value?: { value?: unknown };
};

export type BrowserElementFingerprint = {
  origin: string;
  selector: string;
  tag: string;
  frame?: BrowserFramePath;
  role?: string;
  name?: string;
  id?: string;
  testId?: string;
  fieldName?: string;
  inputType?: string;
  placeholder?: string;
  href?: string;
  neighborText?: string;
};

export type BrowserElementCandidate = Omit<BrowserElementFingerprint, 'origin'> & { visible: boolean };
export type BrowserElementMatch = { candidate?: BrowserElementCandidate; score: number; ambiguous: boolean };

function normalizedText(value: string | undefined): string {
  return (value ?? '').trim().toLocaleLowerCase().replace(/\s+/gu, ' ');
}

function addExactScore(expected: string | undefined, actual: string | undefined, match: number, mismatch: number): number {
  if (!expected) return 0;
  return normalizedText(expected) === normalizedText(actual) ? match : mismatch;
}

export function scoreBrowserElementCandidate(fingerprint: BrowserElementFingerprint, candidate: BrowserElementCandidate): number {
  if (fingerprint.tag !== candidate.tag) return Number.NEGATIVE_INFINITY;
  let score = 10 + (candidate.visible ? 5 : 0);
  score += addExactScore(fingerprint.id, candidate.id, 80, -30);
  score += addExactScore(fingerprint.testId, candidate.testId, 70, -25);
  score += addExactScore(fingerprint.fieldName, candidate.fieldName, 45, -15);
  score += addExactScore(fingerprint.role, candidate.role, 18, -8);
  score += addExactScore(fingerprint.inputType, candidate.inputType, 18, -12);
  score += addExactScore(fingerprint.placeholder, candidate.placeholder, 24, -8);
  score += addExactScore(fingerprint.href, candidate.href, 35, -12);
  score += addExactScore(fingerprint.neighborText, candidate.neighborText, 18, -6);
  if (fingerprint.selector === candidate.selector) score += 12;
  const expectedName = normalizedText(fingerprint.name);
  const actualName = normalizedText(candidate.name);
  if (expectedName) {
    if (expectedName === actualName) score += 40;
    else if (actualName && (expectedName.includes(actualName) || actualName.includes(expectedName))) score += 20;
    else score -= 12;
  }
  return score;
}

export function chooseBrowserElementCandidate(
  fingerprint: BrowserElementFingerprint,
  candidates: BrowserElementCandidate[],
  options: { minimumScore?: number; ambiguityMargin?: number } = {}
): BrowserElementMatch {
  const minimumScore = options.minimumScore ?? 35;
  const ambiguityMargin = options.ambiguityMargin ?? 8;
  const ranked = candidates.map((candidate) => ({ candidate, score: scoreBrowserElementCandidate(fingerprint, candidate) }))
    .filter((entry) => Number.isFinite(entry.score)).sort((left, right) => right.score - left.score);
  const best = ranked[0];
  if (!best || best.score < minimumScore) return { score: best?.score ?? Number.NEGATIVE_INFINITY, ambiguous: false };
  const second = ranked[1];
  if (second && second.score >= best.score - ambiguityMargin) return { score: best.score, ambiguous: true };
  return { candidate: best.candidate, score: best.score, ambiguous: false };
}

export function isRetryableBrowserStepError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:Element|Editable element|Focusable element|Select element) not found|could not be safely relocated|Timed out after/iu.test(message);
}

export type BrowserKeyDefinition = { key: string; code: string; windowsVirtualKeyCode: number; text?: string };

const NAMED_BROWSER_KEYS: Record<string, BrowserKeyDefinition> = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' }
};

export function browserKeyDefinition(value: string): BrowserKeyDefinition {
  const named = NAMED_BROWSER_KEYS[value];
  if (named) return named;
  if ([...value].length !== 1) throw new Error(`Unsupported browser key: ${value}`);
  const [character] = [...value];
  if (!character) throw new Error('Browser key must not be empty.');
  const upper = character.toUpperCase();
  return {
    key: character,
    code: /^[a-z]$/iu.test(character) ? `Key${upper}` : /^[0-9]$/u.test(character) ? `Digit${character}` : '',
    windowsVirtualKeyCode: upper.codePointAt(0) ?? 0,
    text: character
  };
}

export function formatAccessibilityTree(nodes: AccessibilityNode[], maxNodes: number): string {
  const lines: string[] = [];
  for (const node of nodes) {
    if (node.ignored) continue;
    const role = typeof node.role?.value === 'string' ? node.role.value : '';
    const name = typeof node.name?.value === 'string' ? node.name.value.trim() : '';
    const value = typeof node.value?.value === 'string' ? node.value.value.trim() : '';
    if (!role || (!name && !value && !['main', 'navigation', 'form', 'article'].includes(role))) continue;
    lines.push(`${role}${name ? `: ${name}` : ''}${value && value !== name ? ` = ${value}` : ''}`);
    if (lines.length >= maxNodes) break;
  }
  return lines.join('\n');
}
