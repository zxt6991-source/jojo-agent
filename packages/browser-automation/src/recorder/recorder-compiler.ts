import {
  BrowserRecordingDocumentSchema,
  type BrowserRecordingDocument,
  type BrowserRecordingParam,
  type BrowserRecordingStep,
  type BrowserTarget
} from '@desktop-agent/contracts';
import { normalizeDomain } from '../security/browser-security';
import { sanitizeRawBrowserEvent, type RawBrowserEvent, type RawWaitHint } from './raw-event';

export const MAX_RAW_BROWSER_EVENTS = 10_000;
export const MAX_COMPILED_BROWSER_STEPS = 200;
export const MAX_COMPILED_BROWSER_PARAMS = 64;
export const MAX_COMPILED_BROWSER_OUTPUTS = 32;
const DUPLICATE_CLICK_WINDOW_MS = 350;
const ACTION_NAVIGATION_WINDOW_MS = 5_000;

export type CompileUserDemoRecordingInput = {
  id: string;
  name: string;
  description?: string;
  scope?: 'user' | 'project';
  createdAt: string;
  events: RawBrowserEvent[];
  domains?: string[];
};

export function compileUserDemoRecording(input: CompileUserDemoRecordingInput): BrowserRecordingDocument {
  const events = compressRawBrowserEvents(input.events);
  const params: BrowserRecordingParam[] = [];
  const paramByTarget = new Map<string, string>();
  const outputs: BrowserRecordingDocument['outputs'] = [];
  const steps: BrowserRecordingStep[] = [];
  const domains = new Set((input.domains ?? []).map(normalizeDomain).filter(Boolean));
  let lastActionTimestamp = Number.NEGATIVE_INFINITY;
  let lastUrl: string | undefined;

  const addStep = (step: Omit<BrowserRecordingStep, 'id'>): BrowserRecordingStep => {
    const value = { ...step, id: `step-${steps.length + 1}` } as BrowserRecordingStep;
    steps.push(value);
    return value;
  };

  for (const event of events) {
    if (steps.length >= MAX_COMPILED_BROWSER_STEPS) break;
    const url = safeHttpUrl(event.url);
    if (url) domains.add(normalizeDomain(url.hostname));
    if (event.type === 'navigate') {
      if (!url || url.href === lastUrl) continue;
      if (event.frame) {
        const previous = steps.at(-1);
        if (previous && isInteraction(previous.action) && sameFrame(previous.target?.frame, event.frame)
          && event.timestamp - lastActionTimestamp <= ACTION_NAVIGATION_WINDOW_MS) {
          previous.wait = mergeWait(previous.wait, { type: 'network_idle' });
        }
        continue;
      }
      lastUrl = url.href;
      const previous = steps.at(-1);
      if (previous && isInteraction(previous.action) && event.timestamp - lastActionTimestamp <= ACTION_NAVIGATION_WINDOW_MS) {
        previous.wait = mergeWait(previous.wait, { type: 'network_idle' });
        previous.verify = { ...(previous.verify ?? {}), urlContains: `${url.pathname}${url.search}${url.hash}` || '/' };
      } else {
        addStep({ action: 'navigate', url: url.href });
      }
      continue;
    }
    if (event.type === 'wait' && event.wait) {
      const previous = steps.at(-1);
      if (previous && (!event.frame || sameFrame(previous.target?.frame, event.frame))) {
        previous.wait = mergeWait(previous.wait, event.wait);
      }
      continue;
    }
    if (event.type === 'click' && event.target) {
      addStep({ action: 'click', target: event.target });
      lastActionTimestamp = event.timestamp;
      continue;
    }
    if (event.type === 'change' && event.target) {
      const name = ensureParam(params, paramByTarget, event.target, event.secret === true);
      if (!name) continue;
      addStep({ action: 'type', target: event.target, value: `{{${name}}}`, ...(event.secret ? {} : { verify: { valueNotEmpty: true } }) });
      lastActionTimestamp = event.timestamp;
      continue;
    }
    if (event.type === 'select' && event.target && event.values?.length) {
      addStep({ action: 'select', target: event.target, values: event.values });
      lastActionTimestamp = event.timestamp;
      continue;
    }
    if (event.type === 'key' && event.key) {
      addStep({ action: 'press', ...(event.target ? { target: event.target } : {}), key: event.key });
      lastActionTimestamp = event.timestamp;
      continue;
    }
    if (event.type === 'upload' && event.target) {
      const name = ensureParam(params, paramByTarget, event.target, false, 'upload_file');
      if (!name) continue;
      addStep({ action: 'upload', target: event.target, paths: [`{{${name}}}`] });
      lastActionTimestamp = event.timestamp;
      continue;
    }
    if (event.type === 'download' && event.target) {
      if (outputs.length >= MAX_COMPILED_BROWSER_OUTPUTS) continue;
      const previous = steps.at(-1);
      if (previous?.action === 'click' && previous.target && sameTarget(previous.target, event.target)) steps.pop();
      const outputName = uniqueName(
        identifier(event.download?.suggestedFilename?.replace(/\.[^.]+$/u, '') || 'download'),
        new Set(outputs.map((output) => output.name))
      );
      outputs.push({ name: outputName, type: 'file' });
      addStep({ action: 'download', target: event.target, bind: outputName, verify: { downloadCompleted: true } });
      lastActionTimestamp = event.timestamp;
    }
  }

  const updatedAt = new Date().toISOString();
  return BrowserRecordingDocumentSchema.parse({
    version: 2,
    id: input.id,
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    scope: input.scope ?? 'user',
    domains: [...domains].sort(),
    params,
    outputs,
    steps,
    revision: 1,
    contentHash: '',
    createdAt: input.createdAt,
    updatedAt
  });
}

export function compressRawBrowserEvents(source: RawBrowserEvent[]): RawBrowserEvent[] {
  const sorted = source.slice(0, MAX_RAW_BROWSER_EVENTS).map(sanitizeRawBrowserEvent)
    .sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id));
  const result: RawBrowserEvent[] = [];
  for (const event of sorted) {
    const previous = result.at(-1);
    if (event.type === 'change' && previous?.type === 'change' && sameTarget(event.target, previous.target)) {
      result[result.length - 1] = event;
      continue;
    }
    if (event.type === 'select' && previous?.type === 'select' && sameTarget(event.target, previous.target)) {
      result[result.length - 1] = event;
      continue;
    }
    if (event.type === 'click' && previous?.type === 'click' && sameTarget(event.target, previous.target)
      && event.timestamp - previous.timestamp <= DUPLICATE_CLICK_WINDOW_MS) continue;
    if (event.type === 'wait' && previous?.type === 'wait' && event.wait?.type === previous.wait?.type) {
      result[result.length - 1] = event;
      continue;
    }
    if (event.type === 'navigate' && previous?.type === 'navigate' && event.url === previous.url) continue;
    result.push(event);
  }
  return result;
}

function ensureParam(
  params: BrowserRecordingParam[],
  byTarget: Map<string, string>,
  target: BrowserTarget,
  secret: boolean,
  fallback = 'value'
): string | undefined {
  const key = targetKey(target);
  const existing = byTarget.get(key);
  if (existing) {
    if (secret) {
      const param = params.find((item) => item.name === existing);
      if (param) param.secret = true;
    }
    return existing;
  }
  if (params.length >= MAX_COMPILED_BROWSER_PARAMS) return undefined;
  const fingerprint = target.fingerprint;
  const preferred = fingerprint?.fieldName || fingerprint?.id || fingerprint?.accessibleName || fallback;
  const name = uniqueName(identifier(secret && !preferred ? 'password' : preferred), new Set(params.map((param) => param.name)));
  params.push({
    name,
    type: 'string',
    secret,
    required: true,
    description: `${secret ? 'Secret value' : 'Value'} for ${fingerprint?.accessibleName || fingerprint?.fieldName || target.selector || 'recorded field'}`
  });
  byTarget.set(key, name);
  return name;
}

function mergeWait(current: BrowserRecordingStep['wait'], hint: RawWaitHint): BrowserRecordingStep['wait'] {
  if (hint.type === 'network_idle') return { ...(current ?? {}), networkIdle: true, timeoutMs: current?.timeoutMs ?? 15_000 };
  if (hint.type === 'dom_stable') return {
    ...(current ?? {}),
    domStableMs: Math.max(current?.domStableMs ?? 0, hint.stableMs ?? 300),
    timeoutMs: current?.timeoutMs ?? 15_000
  };
  return { ...(current ?? {}), newPage: true, timeoutMs: current?.timeoutMs ?? 15_000 };
}

function safeHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url : undefined;
  } catch { return undefined; }
}

function targetKey(target: BrowserTarget): string {
  const local = target.selector || target.fingerprint?.primarySelector || [
    target.fingerprint?.tag,
    target.fingerprint?.fieldName,
    target.fingerprint?.accessibleName
  ].filter(Boolean).join(':');
  return `${JSON.stringify(target.frame?.selectors ?? [])}:${local}`;
}

function sameTarget(left: BrowserTarget | undefined, right: BrowserTarget | undefined): boolean {
  return Boolean(left && right && targetKey(left) === targetKey(right));
}

function sameFrame(left: BrowserTarget['frame'] | undefined, right: BrowserTarget['frame'] | undefined): boolean {
  return JSON.stringify(left?.selectors ?? []) === JSON.stringify(right?.selectors ?? []);
}

function identifier(value: string): string {
  const normalized = value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9_]+/gu, '_').replace(/^_+|_+$/gu, '').slice(0, 64);
  if (!normalized) return 'value';
  return /^[a-z_]/u.test(normalized) ? normalized : `p_${normalized}`.slice(0, 64);
}

function uniqueName(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base;
  for (let index = 2; index < 1_000; index += 1) {
    const suffix = `_${index}`;
    const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error(`Could not allocate a unique recording name for ${base}.`);
}

function isInteraction(action: BrowserRecordingStep['action']): boolean {
  return ['click', 'type', 'press', 'select', 'upload', 'download'].includes(action);
}
