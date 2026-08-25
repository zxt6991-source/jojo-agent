import {
  BrowserFramePathSchema,
  BrowserTargetSchema,
  type BrowserFramePath,
  type BrowserTarget
} from '@desktop-agent/contracts';

export type RawBrowserEventType =
  | 'navigate'
  | 'click'
  | 'change'
  | 'key'
  | 'select'
  | 'upload'
  | 'download'
  | 'wait';

export type RawWaitHint =
  | { type: 'network_idle'; idleMs?: number }
  | { type: 'dom_stable'; stableMs?: number }
  | { type: 'new_page' };

export type RawBrowserEvent = {
  id: string;
  timestamp: number;
  type: RawBrowserEventType;
  pageId: string;
  url: string;
  frame?: BrowserFramePath;
  target?: BrowserTarget;
  value?: string;
  values?: string[];
  key?: string;
  secret?: boolean;
  wait?: RawWaitHint;
  download?: { suggestedFilename?: string };
};

export type BrowserRecorderBindingPayload = Omit<RawBrowserEvent, 'id' | 'pageId'>;

const EVENT_TYPES = new Set<RawBrowserEventType>([
  'navigate', 'click', 'change', 'key', 'select', 'upload', 'download', 'wait'
]);

export function parseBrowserRecorderBindingPayload(value: string): BrowserRecorderBindingPayload | undefined {
  let raw: unknown;
  try { raw = JSON.parse(value); } catch { return undefined; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const input = raw as Record<string, unknown>;
  if (typeof input.type !== 'string' || !EVENT_TYPES.has(input.type as RawBrowserEventType)) return undefined;
  const type = input.type as RawBrowserEventType;
  const timestamp = typeof input.timestamp === 'number' && Number.isFinite(input.timestamp) ? input.timestamp : Date.now();
  const url = typeof input.url === 'string' ? input.url.slice(0, 4_096) : '';
  const targetResult = input.target === undefined ? undefined : BrowserTargetSchema.safeParse(input.target);
  if (input.target !== undefined && !targetResult?.success) return undefined;
  const frameResult = input.frame === undefined ? undefined : BrowserFramePathSchema.safeParse(input.frame);
  if (input.frame !== undefined && !frameResult?.success) return undefined;
  const secret = input.secret === true;
  const valueText = !secret && typeof input.value === 'string' ? input.value.slice(0, 100_000) : undefined;
  const values = Array.isArray(input.values)
    ? input.values.filter((item): item is string => typeof item === 'string').slice(0, 20).map((item) => item.slice(0, 1_000))
    : undefined;
  const key = typeof input.key === 'string' ? input.key.slice(0, 32) : undefined;
  const wait = parseWaitHint(input.wait);
  const filename = input.download && typeof input.download === 'object' && !Array.isArray(input.download)
    && typeof (input.download as Record<string, unknown>).suggestedFilename === 'string'
    ? String((input.download as Record<string, unknown>).suggestedFilename).slice(0, 255)
    : undefined;
  return {
    type,
    timestamp,
    url,
    ...(frameResult?.success ? { frame: frameResult.data } : {}),
    ...(targetResult?.success ? { target: targetResult.data } : {}),
    ...(valueText !== undefined ? { value: valueText } : {}),
    ...(values?.length ? { values } : {}),
    ...(key ? { key } : {}),
    ...(secret ? { secret: true } : {}),
    ...(wait ? { wait } : {}),
    ...(filename ? { download: { suggestedFilename: filename } } : {})
  };
}

export function sanitizeRawBrowserEvent(event: RawBrowserEvent): RawBrowserEvent {
  if (!event.secret) return event;
  const safe = { ...event };
  delete safe.value;
  delete safe.values;
  return safe;
}

function parseWaitHint(value: unknown): RawWaitHint | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (input.type === 'network_idle') {
    const idleMs = boundedNumber(input.idleMs, 100, 10_000);
    return { type: 'network_idle', ...(idleMs ? { idleMs } : {}) };
  }
  if (input.type === 'dom_stable') {
    const stableMs = boundedNumber(input.stableMs, 100, 10_000);
    return { type: 'dom_stable', ...(stableMs ? { stableMs } : {}) };
  }
  if (input.type === 'new_page') return { type: 'new_page' };
  return undefined;
}

function boundedNumber(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum ? value : undefined;
}
