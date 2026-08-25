import type { BrowserFramePath } from '@desktop-agent/contracts';

export type BrowserFrameSession = {
  sessionId: string;
  targetId: string;
  url: string;
  framePath?: BrowserFramePath;
  recorderScriptId?: string;
};

export type BrowserFrameRoute = {
  sessionId?: string;
  localSelectors: string[];
};

type FrameProbe = { found: boolean; sameOrigin: boolean; src?: string };

export function mergeBrowserFramePaths(
  outer: BrowserFramePath | undefined,
  inner: BrowserFramePath | undefined
): BrowserFramePath | undefined {
  const selectors = [...(outer?.selectors ?? []), ...(inner?.selectors ?? [])];
  return selectors.length > 0 ? { selectors: selectors.slice(0, 16) } : undefined;
}

export function browserFramePathKey(frame: BrowserFramePath | undefined): string {
  return JSON.stringify(frame?.selectors ?? []);
}

/** Wrap an expression so its `document` parameter points at a same-origin nested frame. */
export function expressionInBrowserFrame(localSelectors: readonly string[], body: string): string {
  const nestedSource = JSON.stringify(`return (() => { ${body} })();`);
  return `(() => {
    let frameDocument = document;
    for (const selector of ${JSON.stringify(localSelectors)}) {
      const owner = frameDocument.querySelector(selector);
      if (!(owner instanceof HTMLIFrameElement || owner instanceof HTMLFrameElement)) {
        throw new Error('Browser frame was not found: ' + selector);
      }
      try {
        if (!owner.contentDocument) throw new Error('cross-origin');
        frameDocument = owner.contentDocument;
      } catch {
        throw new Error('Browser frame became cross-origin: ' + selector);
      }
    }
    if (frameDocument !== document && frameDocument.defaultView) {
      return frameDocument.defaultView.Function(${nestedSource}).call(frameDocument.defaultView);
    }
    return ((document) => { ${body} })(frameDocument);
  })()`;
}

export async function resolveBrowserFrameRoute(
  frame: BrowserFramePath | undefined,
  sessions: Iterable<BrowserFrameSession>,
  evaluate: (sessionId: string | undefined, expression: string) => Promise<unknown>
): Promise<BrowserFrameRoute> {
  if (!frame?.selectors.length) return { localSelectors: [] };
  let sessionId: string | undefined;
  const localSelectors: string[] = [];
  const available = [...sessions];
  for (const selector of frame.selectors) {
    const probe = await evaluate(sessionId, expressionInBrowserFrame(localSelectors, `
      const owner = document.querySelector(${JSON.stringify(selector)});
      if (!(owner instanceof HTMLIFrameElement || owner instanceof HTMLFrameElement)) return { found: false, sameOrigin: false };
      let sameOrigin = false;
      try { sameOrigin = Boolean(owner.contentDocument); } catch {}
      return { found: true, sameOrigin, src: owner.src || owner.getAttribute('src') || 'about:blank' };
    `)) as FrameProbe | undefined;
    if (!probe?.found) throw new Error(`Browser frame was not found: ${selector}`);
    if (probe.sameOrigin) {
      localSelectors.push(selector);
      continue;
    }
    const matches = matchingFrameSessions(available, probe.src ?? '');
    if (matches.length !== 1) {
      throw new Error(matches.length === 0
        ? `Cross-origin browser frame is not attached: ${selector}`
        : `Cross-origin browser frame is ambiguous: ${selector}`);
    }
    sessionId = matches[0]!.sessionId;
    localSelectors.length = 0;
  }
  return { ...(sessionId ? { sessionId } : {}), localSelectors };
}

function matchingFrameSessions(sessions: BrowserFrameSession[], source: string): BrowserFrameSession[] {
  const exact = sessions.filter((session) => sameUrl(session.url, source));
  if (exact.length > 0) return exact;
  const sourceOrigin = safeOrigin(source);
  if (!sourceOrigin) return [];
  return sessions.filter((session) => safeOrigin(session.url) === sourceOrigin);
}

function sameUrl(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right, leftUrl);
    leftUrl.hash = '';
    rightUrl.hash = '';
    return leftUrl.href === rightUrl.href;
  } catch { return left === right; }
}

function safeOrigin(value: string): string | undefined {
  try { return new URL(value).origin; } catch { return undefined; }
}
