import { createHash } from 'node:crypto';
import type { Tool, ToolCall } from '@desktop-agent/contracts';

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function fingerprintToolCall(call: ToolCall): string {
  return `${call.name}:${sha256(canonicalJson(call.input))}`;
}

export function fingerprintToolBatch(calls: ToolCall[], toolsByName: Map<string, Tool>): string | null {
  const fingerprints = calls
    .filter((call) => {
      const tool = toolsByName.get(call.name);
      return (tool?.repeatPolicy ?? tool?.definition.repeatPolicy) !== 'polling';
    })
    .map(fingerprintToolCall)
    .sort();
  return fingerprints.length ? sha256(fingerprints.join('|')) : null;
}

/** Removes common transport noise before comparing read-only observations. */
export function normalizeObservation(content: string): string {
  return content
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, '<timestamp>')
    .replace(/\b(request[_-]?id|trace[_-]?id|correlation[_-]?id)\s*[:=]\s*["']?[\w.-]+["']?/gi, '$1=<id>')
    .replace(/\b(next[_-]?cursor|page[_-]?token)\s*[:=]\s*["']?[\w.+/=-]+["']?/gi, '$1=<cursor>')
    .replace(/\s+/g, ' ')
    .trim();
}
