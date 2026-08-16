import { z } from 'zod';
import {
  BrowserActionSchema,
  BROWSER_RECORDING_PARAM_NAME_PATTERN,
  BrowserRecordingIdSchema,
  type ApprovalRequest,
  type BrowserAction,
  type BrowserSettings,
  type PermissionDecision,
  type PermissionGate,
  type Tool,
  type ToolCall,
  type ToolContext,
  type ToolResult,
  type WorkerMessage
} from '@desktop-agent/contracts';

type BrowserRequestPost = (message: Extract<WorkerMessage, { type: 'browser.request' }>) => void;

const BrowserOpenInput = z.object({ url: z.string().url() });
const BrowserNewPageInput = z.object({ url: z.string().url() });
const BrowserPagesInput = z.object({});
const BrowserSelectPageInput = z.object({ pageId: z.number().int().positive() });
const BrowserClosePageInput = z.object({ pageId: z.number().int().positive() });
const BrowserRecordStartInput = z.object({ name: z.string().trim().min(1).max(120).optional() });
const BrowserRecordStopInput = z.object({});
const BrowserRecordCancelInput = z.object({});
const BrowserRecordingsInput = z.object({});
const BrowserRecordGetInput = z.object({ recordingId: BrowserRecordingIdSchema });
const BrowserRecordDeleteInput = z.object({ recordingId: BrowserRecordingIdSchema });
const BrowserReplayInput = z.object({
  recordingId: BrowserRecordingIdSchema,
  params: z.record(
    z.string().regex(BROWSER_RECORDING_PARAM_NAME_PATTERN),
    z.union([z.string().max(4_000), z.number(), z.boolean()])
  ).default({}),
  maxRetries: z.number().int().min(0).max(3).default(2),
  retryDelayMs: z.number().int().min(100).max(2_000).default(250)
});
const BrowserReadInput = z.object({ maxNodes: z.number().int().min(20).max(2_000).default(300) });
const BrowserEvalInput = z.object({ js: z.string().trim().min(1).max(20_000) });
const BrowserSelector = z.string().trim().min(1).max(2_000);
const BrowserElementRef = z.string().regex(/^e[1-9][0-9]*$/u);

function targetInput<T extends z.ZodRawShape>(shape: T, required: boolean) {
  return z.object({ selector: BrowserSelector.optional(), ref: BrowserElementRef.optional(), ...shape }).superRefine((input, context) => {
    const target = input as { selector?: string; ref?: string };
    if (target.selector && target.ref) context.addIssue({ code: 'custom', message: 'Provide either selector or ref, not both.' });
    if (required && !target.selector && !target.ref) context.addIssue({ code: 'custom', message: 'Provide selector or ref.' });
  });
}

const BrowserWaitInput = targetInput({
  state: z.enum(['attached', 'detached', 'visible', 'hidden']).default('visible'),
  timeoutMs: z.number().int().min(100).max(30_000).default(5_000)
}, true);
const BrowserScrollInput = targetInput({
  deltaX: z.number().int().min(-100_000).max(100_000).default(0),
  deltaY: z.number().int().min(-100_000).max(100_000).default(600)
}, false);
const BrowserClickInput = targetInput({}, true);
const BrowserHoverInput = targetInput({}, true);
const BrowserTypeInput = targetInput({ text: z.string().max(100_000), submit: z.boolean().default(false) }, true);
const BrowserPressInput = targetInput({
  key: z.union([
    z.enum(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Space']),
    z.string().length(1)
  ])
}, false);
const BrowserSelectInput = targetInput({
  values: z.array(z.string().max(1_000)).min(1).max(20)
}, true);
const BrowserUploadInput = targetInput({
  paths: z.array(z.string().trim().min(1).max(4_096)).min(1).max(10)
}, true);
const BrowserBackInput = z.object({});
const BrowserReloadInput = z.object({});
const BrowserScreenshotInput = z.object({ fullPage: z.boolean().default(false) });
const BrowserDownloadInput = z.object({ url: z.string().url(), filename: z.string().trim().min(1).max(255).optional() });
const BrowserDownloadsInput = z.object({});
const BrowserConsoleInput = z.object({
  level: z.enum(['debug', 'info', 'warning', 'error']).optional(),
  limit: z.number().int().min(1).max(200).default(80),
  clear: z.boolean().default(false)
});
const BrowserNetworkInput = z.object({
  failedOnly: z.boolean().default(false),
  urlContains: z.string().trim().min(1).max(500).optional(),
  resourceType: z.enum([
    'mainFrame', 'subFrame', 'stylesheet', 'script', 'image', 'font',
    'object', 'xhr', 'ping', 'cspReport', 'media', 'webSocket', 'other'
  ]).optional(),
  limit: z.number().int().min(1).max(200).default(80),
  clear: z.boolean().default(false)
});
const BrowserErrorsInput = z.object({
  kind: z.enum(['exception', 'failed_load', 'log']).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  clear: z.boolean().default(false)
});
const BrowserCookiesInput = z.object({ includeValues: z.boolean().default(false) });

const ACTIONS = {
  browser_open: { schema: BrowserOpenInput, action: 'open', description: 'Open an HTTP(S) URL in the isolated controlled browser. For ordinary search or reading a public page, use web_search or web_fetch instead.' },
  browser_new_page: { schema: BrowserNewPageInput, action: 'new_page', description: 'Open an HTTP(S) URL in a new isolated browser page.' },
  browser_pages: { schema: BrowserPagesInput, action: 'pages', description: 'List controlled browser pages and identify the active page.' },
  browser_select_page: { schema: BrowserSelectPageInput, action: 'select_page', description: 'Select and focus a controlled browser page.' },
  browser_close_page: { schema: BrowserClosePageInput, action: 'close_page', description: 'Close a controlled browser page by id.' },
  browser_record_start: { schema: BrowserRecordStartInput, action: 'record_start', description: 'Start recording successful browser workflow steps. Stopping saves a YAML file under userData/browser-recordings that survives app restart.' },
  browser_record_stop: { schema: BrowserRecordStopInput, action: 'record_stop', description: 'Stop the active browser workflow recording and persist it as YAML.' },
  browser_record_cancel: { schema: BrowserRecordCancelInput, action: 'record_cancel', description: 'Cancel the active browser workflow recording without saving.' },
  browser_recordings: { schema: BrowserRecordingsInput, action: 'recordings', description: 'List persisted browser workflow recordings without exposing typed text or secret values.' },
  browser_record_get: { schema: BrowserRecordGetInput, action: 'record_get', description: 'Read a persisted browser recording as YAML. Typed text is replaced with character counts.' },
  browser_record_delete: { schema: BrowserRecordDeleteInput, action: 'record_delete', description: 'Delete a persisted browser recording YAML file. Requires approval.' },
  browser_replay: { schema: BrowserReplayInput, action: 'replay', description: 'Replay a persisted browser workflow. Pass non-secret params here; secret params must come from JOJO_BROWSER_SECRET_<NAME> or the password prompt, never from this object.' },
  browser_read: { schema: BrowserReadInput, action: 'read', description: 'Read visible semantic page nodes and stable element refs for later actions. Use web_fetch for public pages that only need to be read as text.' },
  browser_eval: { schema: BrowserEvalInput, action: 'eval', description: 'Evaluate JavaScript in the active page and return a JSON-safe result. Requires approval. Use for extracting structured DOM data, Shadow DOM, or SPA state. Do not use this to bypass domain or file permissions.' },
  browser_wait: { schema: BrowserWaitInput, action: 'wait', description: 'Wait until an element selected by ref or CSS selector is attached, detached, visible, or hidden.' },
  browser_scroll: { schema: BrowserScrollInput, action: 'scroll', description: 'Scroll by an offset or bring an element selected by ref or CSS selector into view.' },
  browser_click: { schema: BrowserClickInput, action: 'click', description: 'Click an element by stable ref (preferred) or CSS selector.' },
  browser_hover: { schema: BrowserHoverInput, action: 'hover', description: 'Hover an element by stable ref (preferred) or CSS selector to reveal menus, tooltips, or CSS :hover content.' },
  browser_type: { schema: BrowserTypeInput, action: 'type', description: 'Enter text into an element by stable ref (preferred) or CSS selector.' },
  browser_press: { schema: BrowserPressInput, action: 'press', description: 'Press a keyboard key, optionally focusing an element by stable ref or CSS selector.' },
  browser_select: { schema: BrowserSelectInput, action: 'select', description: 'Select option values in a select element by stable ref (preferred) or CSS selector.' },
  browser_upload: { schema: BrowserUploadInput, action: 'upload', description: 'Upload workspace files into a file input by stable ref (preferred) or CSS selector.' },
  browser_back: { schema: BrowserBackInput, action: 'back', description: 'Navigate the controlled browser back one history entry.' },
  browser_reload: { schema: BrowserReloadInput, action: 'reload', description: 'Reload the current page and wait for navigation to finish.' },
  browser_screenshot: { schema: BrowserScreenshotInput, action: 'screenshot', description: 'Capture the current browser page as a quality-controlled JPEG image for visual inspection.' },
  browser_download: { schema: BrowserDownloadInput, action: 'download', description: 'Download an HTTP(S) URL through the isolated browser session.' },
  browser_downloads: { schema: BrowserDownloadsInput, action: 'downloads', description: 'List downloads created by the controlled browser for this session.' },
  browser_console: { schema: BrowserConsoleInput, action: 'console', description: 'Read captured console messages for the active controlled browser page.' },
  browser_network: { schema: BrowserNetworkInput, action: 'network', description: 'Read captured network requests for the active controlled browser page. Does not include headers or bodies.' },
  browser_errors: { schema: BrowserErrorsInput, action: 'errors', description: 'Read captured JavaScript exceptions, failed main-frame loads, and browser error logs for the active page.' },
  browser_cookies: { schema: BrowserCookiesInput, action: 'cookies', description: 'List cookies for the controlled browser session. By default only name, domain, path, and flags are returned. Set includeValues true to request cookie values; that requires approval and still stays in this isolated session.' }
} as const;

type BrowserToolName = keyof typeof ACTIONS;

const TARGET_PROPERTIES = {
  selector: { type: 'string', description: 'CSS selector. Pass either selector or ref, not both. Prefer ref from browser_read when available.' },
  ref: { type: 'string', pattern: '^e[1-9][0-9]*$', description: 'Stable element ref from browser_read. Pass either ref or selector, not both.' }
} as const;

function targetObjectSchema(properties: Record<string, unknown> = {}, required: string[] = []): Record<string, unknown> {
  return {
    type: 'object',
    properties: { ...TARGET_PROPERTIES, ...properties },
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false
  };
}

function inputSchemaFor(name: BrowserToolName): Record<string, unknown> {
  if (name === 'browser_open') return { type: 'object', properties: { url: { type: 'string', format: 'uri' } }, required: ['url'], additionalProperties: false };
  if (name === 'browser_new_page') return { type: 'object', properties: { url: { type: 'string', format: 'uri' } }, required: ['url'], additionalProperties: false };
  if (name === 'browser_pages') return { type: 'object', properties: {}, additionalProperties: false };
  if (name === 'browser_select_page' || name === 'browser_close_page') return {
    type: 'object', properties: { pageId: { type: 'integer', minimum: 1 } }, required: ['pageId'], additionalProperties: false
  };
  if (name === 'browser_record_start') return {
    type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 120 } }, additionalProperties: false
  };
  if (name === 'browser_record_stop' || name === 'browser_record_cancel' || name === 'browser_recordings') return { type: 'object', properties: {}, additionalProperties: false };
  if (name === 'browser_record_get' || name === 'browser_record_delete') return {
    type: 'object',
    properties: { recordingId: { type: 'string', pattern: '^(?:r[1-9][0-9]*|[a-z0-9][a-z0-9-]{0,79})$' } },
    required: ['recordingId'],
    additionalProperties: false
  };
  if (name === 'browser_replay') return {
    type: 'object',
    properties: {
      recordingId: { type: 'string', pattern: '^(?:r[1-9][0-9]*|[a-z0-9][a-z0-9-]{0,79})$' },
      params: {
        type: 'object',
        additionalProperties: true,
        description: 'Non-secret recording parameters. Values must be string, number, or boolean. Never put passwords or tokens here.'
      },
      maxRetries: { type: 'integer', minimum: 0, maximum: 3, default: 2 },
      retryDelayMs: { type: 'integer', minimum: 100, maximum: 2000, default: 250 }
    },
    required: ['recordingId'], additionalProperties: false
  };
  if (name === 'browser_read') return { type: 'object', properties: { maxNodes: { type: 'integer', minimum: 20, maximum: 2000, default: 300 } }, additionalProperties: false };
  if (name === 'browser_eval') return {
    type: 'object',
    properties: { js: { type: 'string', minLength: 1, maxLength: 20000, description: 'JavaScript expression or statement to evaluate in the page.' } },
    required: ['js'],
    additionalProperties: false
  };
  if (name === 'browser_wait') return targetObjectSchema({
    state: { type: 'string', enum: ['attached', 'detached', 'visible', 'hidden'], default: 'visible' },
    timeoutMs: { type: 'integer', minimum: 100, maximum: 30000, default: 5000 }
  });
  if (name === 'browser_scroll') return targetObjectSchema({
    deltaX: { type: 'integer', minimum: -100000, maximum: 100000, default: 0 },
    deltaY: { type: 'integer', minimum: -100000, maximum: 100000, default: 600 }
  });
  if (name === 'browser_click') return targetObjectSchema();
  if (name === 'browser_hover') return targetObjectSchema();
  if (name === 'browser_type') return targetObjectSchema({ text: { type: 'string' }, submit: { type: 'boolean', default: false } }, ['text']);
  if (name === 'browser_press') return targetObjectSchema({ key: { type: 'string', minLength: 1, maxLength: 32 } }, ['key']);
  if (name === 'browser_select') return targetObjectSchema({
    values: { type: 'array', items: { type: 'string', maxLength: 1000 }, minItems: 1, maxItems: 20 }
  }, ['values']);
  if (name === 'browser_upload') return targetObjectSchema({
    paths: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 4096 }, minItems: 1, maxItems: 10 }
  }, ['paths']);
  if (name === 'browser_back' || name === 'browser_reload') return { type: 'object', properties: {}, additionalProperties: false };
  if (name === 'browser_screenshot') return { type: 'object', properties: { fullPage: { type: 'boolean', default: false } }, additionalProperties: false };
  if (name === 'browser_download') return { type: 'object', properties: { url: { type: 'string', format: 'uri' }, filename: { type: 'string' } }, required: ['url'], additionalProperties: false };
  if (name === 'browser_console') return {
    type: 'object',
    properties: {
      level: { type: 'string', enum: ['debug', 'info', 'warning', 'error'], description: 'Return only this console severity.' },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 80 },
      clear: { type: 'boolean', default: false, description: 'Clear captured console messages after reading.' }
    },
    additionalProperties: false
  };
  if (name === 'browser_network') return {
    type: 'object',
    properties: {
      failedOnly: { type: 'boolean', default: false, description: 'Return only failed or HTTP 4xx/5xx requests.' },
      urlContains: { type: 'string', minLength: 1, maxLength: 500 },
      resourceType: {
        type: 'string',
        enum: ['mainFrame', 'subFrame', 'stylesheet', 'script', 'image', 'font', 'object', 'xhr', 'ping', 'cspReport', 'media', 'webSocket', 'other']
      },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 80 },
      clear: { type: 'boolean', default: false, description: 'Clear captured network requests after reading.' }
    },
    additionalProperties: false
  };
  if (name === 'browser_errors') return {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['exception', 'failed_load', 'log'], description: 'Return only this page-error kind.' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
      clear: { type: 'boolean', default: false, description: 'Clear captured page errors after reading.' }
    },
    additionalProperties: false
  };
  if (name === 'browser_cookies') return {
    type: 'object',
    properties: { includeValues: { type: 'boolean', default: false, description: 'Include cookie values. Requires approval.' } },
    additionalProperties: false
  };
  return { type: 'object', properties: {}, additionalProperties: false };
}

function toAction(name: BrowserToolName, input: unknown): BrowserAction {
  const spec = ACTIONS[name];
  const parsed = spec.schema.parse(input) as Record<string, unknown>;
  return BrowserActionSchema.parse({ action: spec.action, ...parsed });
}

function hostAllowed(urlValue: string, rules: string[]): boolean {
  let hostname: string;
  try {
    const url = new URL(urlValue);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
    hostname = url.hostname.toLowerCase().replace(/\.$/u, '');
  } catch { return false; }
  return rules.some((value) => {
    const rule = value.toLowerCase().replace(/\.$/u, '');
    return rule.startsWith('*.') ? hostname !== rule.slice(2) && hostname.endsWith(`.${rule.slice(2)}`) : hostname === rule;
  });
}

type BrowserToolSettings = Pick<BrowserSettings, 'enabled' | 'allowedDomains'> & Partial<Pick<BrowserSettings, 'mode'>>;

export class BrowserToolBridge {
  private readonly pending = new Map<string, { resolve: (result: ToolResult) => void; reject: (error: Error) => void }>();

  constructor(private readonly post: BrowserRequestPost, private readonly settings: () => BrowserToolSettings) {}

  tools(): Tool[] {
    if (!this.settings().enabled) return [];
    return (Object.keys(ACTIONS) as BrowserToolName[]).map((name) => ({
      definition: { name, description: ACTIONS[name].description, inputSchema: inputSchemaFor(name) },
      execute: (input, context) => this.execute(name, input, context)
    }));
  }

  resolve(requestId: string, result?: ToolResult, error?: string): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    if (error || !result) pending.reject(new Error(error ?? 'Browser runtime returned no result.'));
    else pending.resolve(result);
  }

  private execute(name: BrowserToolName, input: unknown, context: ToolContext): Promise<ToolResult> {
    const action = toAction(name, input);
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const finish = () => {
        this.pending.delete(requestId);
        reject(new DOMException('Cancelled', 'AbortError'));
      };
      if (context.signal.aborted) { finish(); return; }
      context.signal.addEventListener('abort', finish, { once: true });
      this.pending.set(requestId, {
        resolve: (result) => { context.signal.removeEventListener('abort', finish); resolve(result); },
        reject: (error) => { context.signal.removeEventListener('abort', finish); reject(error); }
      });
      this.post({
        type: 'browser.request', requestId, sessionId: context.sessionId, action,
        approved: context.approved
      });
    });
  }
}

export class BrowserPermissionGate implements PermissionGate {
  constructor(private readonly base: PermissionGate, private readonly settings: () => BrowserToolSettings) {}

  async check(call: ToolCall, context: { sessionId: string; workingDirectory: string }): Promise<PermissionDecision> {
    if (!Object.hasOwn(ACTIONS, call.name)) return this.base.check(call, context);
    if (!this.settings().enabled) return { decision: 'deny', reason: 'Browser tools are disabled in Settings.', code: 'browser_disabled' };
    const name = call.name as BrowserToolName;
    let action: BrowserAction;
    try { action = toAction(name, call.input); }
    catch (error) { return { decision: 'deny', reason: error instanceof Error ? error.message : String(error), code: 'invalid_input' }; }
    if (['pages', 'record_stop', 'record_cancel', 'recordings', 'record_get', 'read', 'wait', 'scroll', 'back', 'reload', 'screenshot', 'downloads', 'console', 'network', 'errors'].includes(action.action)) return { decision: 'allow' };
    if (action.action === 'select_page' && this.settings().mode !== 'chrome') return { decision: 'allow' };
    if (action.action === 'cookies' && !action.includeValues) return { decision: 'allow' };
    if ((action.action === 'open' || action.action === 'new_page') && hostAllowed(action.url, this.settings().allowedDomains)) return { decision: 'allow' };
    let reason: string;
    if (action.action === 'open') reason = `Open browser domain ${new URL(action.url).hostname}`;
    else if (action.action === 'new_page') reason = `Open browser domain ${new URL(action.url).hostname} in a new page`;
    else if (action.action === 'select_page') reason = `Attach Chrome tab ${action.pageId}`;
    else if (action.action === 'close_page') reason = `Close browser page ${action.pageId}`;
    else if (action.action === 'record_start') reason = 'Start a browser workflow recording; typed text is saved to YAML when recording stops';
    else if (action.action === 'record_delete') reason = `Delete persisted browser recording ${action.recordingId}`;
    else if (action.action === 'replay') reason = `Replay browser workflow ${action.recordingId}`;
    else if (action.action === 'download') reason = `Download from ${new URL(action.url).hostname}`;
    else if (action.action === 'click') reason = `Click browser element ${action.ref ?? action.selector}`;
    else if (action.action === 'hover') reason = `Hover browser element ${action.ref ?? action.selector}`;
    else if (action.action === 'eval') reason = 'Evaluate JavaScript in the controlled browser page';
    else if (action.action === 'cookies') reason = 'Read controlled-browser cookie values';
    else if (action.action === 'type') reason = `Enter text into browser element ${action.ref ?? action.selector}`;
    else if (action.action === 'press') reason = `Press ${action.key}${action.ref || action.selector ? ` on browser element ${action.ref ?? action.selector}` : ' in the browser'}`;
    else if (action.action === 'select') reason = `Select browser option in ${action.ref ?? action.selector}`;
    else if (action.action === 'upload') reason = `Upload ${action.paths.length} workspace file${action.paths.length === 1 ? '' : 's'} through ${action.ref ?? action.selector}`;
    else return { decision: 'deny', reason: `Unsupported browser action: ${action.action}`, code: 'unsupported_browser_action' };
    const request: ApprovalRequest = { requestId: crypto.randomUUID(), sessionId: context.sessionId, call, reason };
    return { decision: 'ask', request };
  }
}
