export const MAX_BROWSER_CONSOLE_ENTRIES = 200;
export const MAX_BROWSER_NETWORK_ENTRIES = 400;
export const MAX_BROWSER_ERROR_ENTRIES = 100;
export const MAX_BROWSER_DIAGNOSTIC_TEXT = 2_000;
export const MAX_BROWSER_DIAGNOSTIC_URL = 2_000;
export const MAX_BROWSER_DIAGNOSTIC_STACK = 4_000;

export type BrowserConsoleLevel = 'debug' | 'info' | 'warning' | 'error';
export type BrowserNetworkResourceType =
  | 'mainFrame' | 'subFrame' | 'stylesheet' | 'script' | 'image' | 'font'
  | 'object' | 'xhr' | 'ping' | 'cspReport' | 'media' | 'webSocket' | 'other';
export type BrowserPageErrorKind = 'exception' | 'failed_load' | 'log';

export type BrowserConsoleRecord = {
  timestamp: string;
  level: BrowserConsoleLevel;
  text: string;
  url?: string;
  line?: number;
};

export type BrowserNetworkRecord = {
  id: string;
  timestamp: string;
  method: string;
  url: string;
  resourceType?: BrowserNetworkResourceType;
  status?: number;
  fromCache?: boolean;
  error?: string;
  pending?: boolean;
};

export type BrowserPageErrorRecord = {
  timestamp: string;
  kind: BrowserPageErrorKind;
  text: string;
  url?: string;
  line?: number;
  column?: number;
  stack?: string;
};

export type BrowserDiagnosticPage = {
  pageId: number;
  url: string;
  title: string;
};

export function truncateBrowserText(value: string, max = MAX_BROWSER_DIAGNOSTIC_TEXT): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 14))}\n...[truncated]`;
}

export function sanitizeBrowserDiagnosticUrl(value: string): string {
  let sanitized = value;
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
      sanitized = url.toString();
    }
  } catch {
    sanitized = value;
  }
  return truncateBrowserText(sanitized, MAX_BROWSER_DIAGNOSTIC_URL);
}

export function pushBounded<T>(items: T[], item: T, max: number): void {
  items.push(item);
  if (items.length > max) items.splice(0, items.length - max);
}

export function takeLast<T>(items: T[], limit: number): T[] {
  if (limit <= 0) return [];
  return items.length <= limit ? items.slice() : items.slice(items.length - limit);
}

export function normalizeBrowserConsoleLevel(level: string | number | undefined): BrowserConsoleLevel {
  if (level === 'debug' || level === 'verbose' || level === 0) return 'debug';
  if (level === 'warning' || level === 'warn' || level === 2) return 'warning';
  if (level === 'error' || level === 3) return 'error';
  return 'info';
}

export function createBrowserConsoleRecord(input: {
  level?: string | number;
  text: string;
  url?: string;
  line?: number;
  timestamp?: string;
}): BrowserConsoleRecord {
  const record: BrowserConsoleRecord = {
    timestamp: input.timestamp ?? new Date().toISOString(),
    level: normalizeBrowserConsoleLevel(input.level),
    text: truncateBrowserText(input.text)
  };
  if (input.url) record.url = sanitizeBrowserDiagnosticUrl(input.url);
  if (input.line && input.line > 0) record.line = input.line;
  return record;
}

export function createBrowserNetworkRecord(input: {
  id: string;
  method?: string;
  url?: string;
  resourceType?: string;
  status?: number;
  fromCache?: boolean;
  error?: string;
  pending?: boolean;
  timestamp?: string;
}): BrowserNetworkRecord {
  const resourceType = isBrowserNetworkResourceType(input.resourceType) ? input.resourceType : undefined;
  const error = input.error?.trim() ? truncateBrowserText(input.error, 500) : undefined;
  const pending = input.pending ?? (input.status == null && !error);
  const record: BrowserNetworkRecord = {
    id: input.id,
    timestamp: input.timestamp ?? new Date().toISOString(),
    method: (input.method || 'GET').toUpperCase(),
    url: sanitizeBrowserDiagnosticUrl(input.url ?? '')
  };
  if (resourceType) record.resourceType = resourceType;
  if (input.status != null) record.status = input.status;
  if (input.fromCache) record.fromCache = true;
  if (error) record.error = error;
  if (pending) record.pending = true;
  return record;
}

export function upsertBrowserNetworkRecord(records: BrowserNetworkRecord[], incoming: BrowserNetworkRecord): void {
  const index = records.findIndex((record) => record.id === incoming.id);
  const merged = index >= 0 ? mergeBrowserNetworkRecords(records[index]!, incoming) : incoming;
  if (index >= 0) records[index] = merged;
  else pushBounded(records, merged, MAX_BROWSER_NETWORK_ENTRIES);
}

export function isFailedBrowserNetworkRecord(record: BrowserNetworkRecord): boolean {
  return Boolean(record.error) || (record.status != null && record.status >= 400);
}

export function isIgnorableBrowserLoadError(errorCode: number): boolean {
  return errorCode === -3;
}

export function createBrowserPageErrorRecord(input: {
  kind: BrowserPageErrorKind;
  text: string;
  url?: string;
  line?: number;
  column?: number;
  stack?: string;
  timestamp?: string;
}): BrowserPageErrorRecord {
  const record: BrowserPageErrorRecord = {
    timestamp: input.timestamp ?? new Date().toISOString(),
    kind: input.kind,
    text: truncateBrowserText(input.text)
  };
  if (input.url) record.url = sanitizeBrowserDiagnosticUrl(input.url);
  if (input.line != null && input.line >= 0) record.line = input.line;
  if (input.column != null && input.column >= 0) record.column = input.column;
  if (input.stack) record.stack = truncateBrowserText(input.stack, MAX_BROWSER_DIAGNOSTIC_STACK);
  return record;
}

export function exceptionRecordFromCdp(params: unknown): BrowserPageErrorRecord | undefined {
  if (!params || typeof params !== 'object') return undefined;
  const details = (params as { exceptionDetails?: Record<string, unknown> }).exceptionDetails;
  if (!details) return undefined;
  const exception = details.exception && typeof details.exception === 'object'
    ? details.exception as { description?: unknown; value?: unknown }
    : undefined;
  const description = typeof exception?.description === 'string' ? exception.description : undefined;
  const text = description
    || (typeof details.text === 'string' ? details.text : undefined)
    || 'Uncaught exception';
  const stackTrace = details.stackTrace && typeof details.stackTrace === 'object'
    ? details.stackTrace as { callFrames?: Array<{ functionName?: string; url?: string; lineNumber?: number; columnNumber?: number }> }
    : undefined;
  const url = typeof details.url === 'string' ? details.url : undefined;
  const line = typeof details.lineNumber === 'number' ? details.lineNumber + 1 : undefined;
  const column = typeof details.columnNumber === 'number' ? details.columnNumber + 1 : undefined;
  const stack = formatBrowserExceptionStack(stackTrace);
  return createBrowserPageErrorRecord({
    kind: 'exception',
    text,
    ...(url ? { url } : {}),
    ...(line != null ? { line } : {}),
    ...(column != null ? { column } : {}),
    ...(stack ? { stack } : {})
  });
}

export function logErrorRecordFromCdp(params: unknown): BrowserPageErrorRecord | undefined {
  if (!params || typeof params !== 'object') return undefined;
  const entry = (params as { entry?: Record<string, unknown> }).entry;
  if (!entry) return undefined;
  const level = typeof entry.level === 'string' ? entry.level : '';
  if (level !== 'error') return undefined;
  const source = typeof entry.source === 'string' && entry.source ? entry.source : undefined;
  const text = typeof entry.text === 'string' ? entry.text : 'Browser log error';
  const url = typeof entry.url === 'string' ? entry.url : undefined;
  const line = typeof entry.lineNumber === 'number' ? entry.lineNumber : undefined;
  return createBrowserPageErrorRecord({
    kind: 'log',
    text: source ? `[${source}] ${text}` : text,
    ...(url ? { url } : {}),
    ...(line != null ? { line } : {})
  });
}

export function formatBrowserExceptionStack(
  stackTrace: { callFrames?: Array<{ functionName?: string; url?: string; lineNumber?: number; columnNumber?: number }> } | undefined
): string | undefined {
  const frames = stackTrace?.callFrames?.slice(0, 8) ?? [];
  if (!frames.length) return undefined;
  return frames.map((frame) => {
    const name = frame.functionName || '(anonymous)';
    const url = truncateBrowserText(frame.url ?? '', 240);
    return `    at ${name} (${url}:${(frame.lineNumber ?? 0) + 1}:${(frame.columnNumber ?? 0) + 1})`;
  }).join('\n');
}

export function selectBrowserConsoleRecords(
  records: BrowserConsoleRecord[],
  options: { level?: BrowserConsoleLevel; limit: number }
): BrowserConsoleRecord[] {
  const filtered = options.level ? records.filter((record) => record.level === options.level) : records;
  return takeLast(filtered, options.limit);
}

export function selectBrowserNetworkRecords(
  records: BrowserNetworkRecord[],
  options: { failedOnly?: boolean; urlContains?: string; resourceType?: BrowserNetworkResourceType; limit: number }
): BrowserNetworkRecord[] {
  const needle = options.urlContains?.trim().toLowerCase();
  const filtered = records.filter((record) => {
    if (options.failedOnly && !isFailedBrowserNetworkRecord(record)) return false;
    if (options.resourceType && record.resourceType !== options.resourceType) return false;
    if (needle && !record.url.toLowerCase().includes(needle)) return false;
    return true;
  });
  return takeLast(filtered, options.limit);
}

export function selectBrowserErrorRecords(
  records: BrowserPageErrorRecord[],
  options: { kind?: BrowserPageErrorKind; limit: number }
): BrowserPageErrorRecord[] {
  const filtered = options.kind ? records.filter((record) => record.kind === options.kind) : records;
  return takeLast(filtered, options.limit);
}

export function formatBrowserDiagnosticReport<T>(
  page: BrowserDiagnosticPage,
  captured: number,
  entries: T[],
  extra?: Record<string, unknown>
): string {
  return JSON.stringify({
    pageId: page.pageId,
    url: page.url,
    title: page.title,
    captured,
    returned: entries.length,
    omitted: Math.max(0, captured - entries.length),
    ...extra,
    entries
  }, null, 2);
}

export function recentBrowserErrorHint(errors: BrowserPageErrorRecord[], limit = 3): string {
  if (!errors.length) return '';
  const recent = takeLast(errors, limit);
  return `\nRecent page errors:\n${recent.map((entry) => `- ${entry.text}`).join('\n')}`;
}

function mergeBrowserNetworkRecords(existing: BrowserNetworkRecord, incoming: BrowserNetworkRecord): BrowserNetworkRecord {
  const error = incoming.error ?? existing.error;
  const status = incoming.status ?? existing.status;
  const pending = incoming.pending === false || status != null || Boolean(error) ? undefined : incoming.pending ?? existing.pending;
  const merged: BrowserNetworkRecord = {
    id: existing.id,
    timestamp: existing.timestamp,
    method: incoming.method || existing.method,
    url: incoming.url || existing.url
  };
  const resourceType = incoming.resourceType ?? existing.resourceType;
  if (resourceType) merged.resourceType = resourceType;
  if (status != null) merged.status = status;
  if (incoming.fromCache || existing.fromCache) merged.fromCache = true;
  if (error) merged.error = error;
  if (pending) merged.pending = true;
  return merged;
}

function isBrowserNetworkResourceType(value: string | undefined): value is BrowserNetworkResourceType {
  return value === 'mainFrame' || value === 'subFrame' || value === 'stylesheet' || value === 'script'
    || value === 'image' || value === 'font' || value === 'object' || value === 'xhr' || value === 'ping'
    || value === 'cspReport' || value === 'media' || value === 'webSocket' || value === 'other';
}
