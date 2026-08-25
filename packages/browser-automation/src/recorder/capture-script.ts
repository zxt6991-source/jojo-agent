export const BROWSER_RECORDER_BINDING_NAME = '__jojoBrowserRecorder';
export const BROWSER_RECORDER_GUARD_NAME = '__jojoBrowserRecorderInstalledV2';

/**
 * Runs in the page's isolated CDP world. Password-like values are removed before
 * crossing the Runtime binding boundary.
 */
export function createBrowserRecorderCaptureScript(bindingName = BROWSER_RECORDER_BINDING_NAME): string {
  return `(() => {
    const guard = ${JSON.stringify(BROWSER_RECORDER_GUARD_NAME)};
    const existing = globalThis[guard];
    if (existing && typeof existing === 'object') { existing.active = true; return; }
    const controller = { active: true };
    Object.defineProperty(globalThis, guard, { value: controller, configurable: false });
    const binding = ${JSON.stringify(bindingName)};
    let lastActionAt = 0;
    let mutationTimer;
    const send = (event) => {
      if (!controller.active) return;
      const fn = globalThis[binding];
      if (typeof fn !== 'function') return;
      try {
        const frame = framePath();
        fn(JSON.stringify({ timestamp: Date.now(), url: location.href, ...(frame ? { frame } : {}), ...event }));
      } catch {}
    };
    const cssEscape = globalThis.CSS && typeof CSS.escape === 'function'
      ? CSS.escape.bind(CSS)
      : (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, (char) => '\\\\' + char);
    const unique = (selector, ownerDocument = document) => {
      if (!selector) return false;
      try { return ownerDocument.querySelectorAll(selector).length === 1; } catch { return false; }
    };
    const selectorFor = (el) => {
      if (!el || el.nodeType !== 1 || typeof el.tagName !== 'string') return undefined;
      const ownerDocument = el.ownerDocument || document;
      if (el.id) {
        const selector = '#' + cssEscape(el.id);
        if (unique(selector, ownerDocument)) return selector;
      }
      const testId = el.getAttribute('data-testid');
      if (testId) {
        const selector = '[data-testid="' + cssEscape(testId) + '"]';
        if (unique(selector, ownerDocument)) return selector;
      }
      const name = el.getAttribute('name');
      if (name) {
        const selector = el.tagName.toLowerCase() + '[name="' + cssEscape(name) + '"]';
        if (unique(selector, ownerDocument)) return selector;
      }
      const parts = [];
      let current = el;
      while (current && current !== document.documentElement && parts.length < 6) {
        let part = current.tagName.toLowerCase();
        const parent = current.parentElement;
        if (parent) {
          const peers = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
          if (peers.length > 1) part += ':nth-of-type(' + (peers.indexOf(current) + 1) + ')';
        }
        parts.unshift(part);
        current = parent;
      }
      return parts.join(' > ');
    };
    const framePath = () => {
      const selectors = [];
      let current = window;
      try {
        while (current !== current.top && selectors.length < 16) {
          const owner = current.frameElement;
          if (!owner || owner.nodeType !== 1) break;
          const selector = selectorFor(owner);
          if (!selector) break;
          selectors.unshift(selector);
          current = current.parent;
        }
      } catch {}
      return selectors.length ? { selectors } : undefined;
    };
    const targetFor = (event) => {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      const el = path.find((item) => item instanceof Element) || event.target;
      return el instanceof Element ? el : undefined;
    };
    const accessibleName = (el) => {
      if (!(el instanceof Element)) return undefined;
      const labelledBy = el.getAttribute('aria-labelledby');
      const labelledText = labelledBy ? labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ') : '';
      const labelText = 'labels' in el && el.labels && el.labels[0] ? el.labels[0].textContent || '' : '';
      const text = el.getAttribute('aria-label') || labelledText || labelText || el.getAttribute('title')
        || ((el.tagName === 'BUTTON' || el.tagName === 'A') ? el.textContent || '' : '');
      const normalized = text.trim().replace(/\\s+/g, ' ');
      return normalized ? normalized.slice(0, 500) : undefined;
    };
    const targetPayload = (el) => {
      if (!(el instanceof Element)) return undefined;
      const selector = selectorFor(el);
      const tag = el.tagName.toLowerCase();
      const alternateSelectors = [];
      const testId = el.getAttribute('data-testid') || undefined;
      const fieldName = el.getAttribute('name') || undefined;
      if (el.id) alternateSelectors.push('#' + cssEscape(el.id));
      if (testId) alternateSelectors.push('[data-testid="' + cssEscape(testId) + '"]');
      if (fieldName) alternateSelectors.push(tag + '[name="' + cssEscape(fieldName) + '"]');
      return {
        ...(selector ? { selector } : {}),
        ...(framePath() ? { frame: framePath() } : {}),
        fingerprint: {
          ...(selector ? { primarySelector: selector } : {}),
          ...(alternateSelectors.length ? { alternateSelectors: [...new Set(alternateSelectors)].filter((item) => item !== selector) } : {}),
          tag,
          ...(el.getAttribute('role') ? { role: el.getAttribute('role') } : {}),
          ...(accessibleName(el) ? { accessibleName: accessibleName(el) } : {}),
          ...(el.id ? { id: el.id.slice(0, 200) } : {}),
          ...(testId ? { testId: testId.slice(0, 200) } : {}),
          ...(fieldName ? { fieldName: fieldName.slice(0, 200) } : {}),
          ...(el instanceof HTMLInputElement ? { inputType: el.type } : {}),
          ...(el.getAttribute('placeholder') ? { placeholder: el.getAttribute('placeholder').slice(0, 500) } : {}),
          ...(el instanceof HTMLAnchorElement && el.href ? { href: el.href.slice(0, 2000) } : {})
        }
      };
    };
    const passwordLike = (el) => el instanceof HTMLInputElement && (
      el.type === 'password'
      || /(?:current-password|new-password)/i.test(el.autocomplete || '')
      || /(?:pass(word)?|secret|token|credential)/i.test((el.name || '') + ' ' + (el.id || ''))
    );
    const markAction = () => { lastActionAt = Date.now(); };
    document.addEventListener('click', (event) => {
      const el = targetFor(event);
      if (!el) return;
      markAction();
      send({ type: 'click', target: targetPayload(el) });
    }, true);
    const captureValue = (event) => {
      const el = targetFor(event);
      if (!el) return;
      markAction();
      const target = targetPayload(el);
      if (el instanceof HTMLSelectElement) {
        send({ type: 'select', target, values: Array.from(el.selectedOptions).map((option) => option.value).slice(0, 20) });
        return;
      }
      if (el instanceof HTMLInputElement && el.type === 'file') {
        send({ type: 'upload', target });
        return;
      }
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable)) return;
      const secret = passwordLike(el);
      const value = el.isContentEditable ? el.textContent || '' : el.value;
      send({ type: 'change', target, secret, ...(!secret ? { value: value.slice(0, 100000) } : {}) });
    };
    document.addEventListener('input', captureValue, true);
    document.addEventListener('change', captureValue, true);
    document.addEventListener('keydown', (event) => {
      if (!['Enter', 'Tab', 'Escape'].includes(event.key)) return;
      const el = targetFor(event);
      markAction();
      send({ type: 'key', key: event.key, ...(el ? { target: targetPayload(el) } : {}) });
    }, true);
    const navigation = () => send({ type: 'navigate' });
    for (const method of ['pushState', 'replaceState']) {
      const original = history[method];
      if (typeof original !== 'function') continue;
      history[method] = function(...args) {
        const result = original.apply(this, args);
        queueMicrotask(navigation);
        return result;
      };
    }
    addEventListener('popstate', navigation, true);
    addEventListener('hashchange', navigation, true);
    new MutationObserver(() => {
      if (Date.now() - lastActionAt > 5000) return;
      clearTimeout(mutationTimer);
      mutationTimer = setTimeout(() => send({ type: 'wait', wait: { type: 'dom_stable', stableMs: 300 } }), 300);
    }).observe(document, { subtree: true, childList: true, attributes: true });
  })()`;
}
