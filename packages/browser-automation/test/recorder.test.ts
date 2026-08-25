import { describe, expect, it } from 'vitest';
import {
  BROWSER_RECORDER_BINDING_NAME,
  compileUserDemoRecording,
  compressRawBrowserEvents,
  createBrowserRecorderCaptureScript,
  parseBrowserRecorderBindingPayload,
  type RawBrowserEvent
} from '../src';

const usernameTarget = {
  selector: '#username',
  fingerprint: { primarySelector: '#username', tag: 'input', fieldName: 'username', accessibleName: 'Username' }
};
const passwordTarget = {
  selector: '#password',
  fingerprint: { primarySelector: '#password', tag: 'input', fieldName: 'password', inputType: 'password' }
};
const loginTarget = {
  selector: 'button[type="submit"]',
  fingerprint: { primarySelector: 'button[type="submit"]', tag: 'button', accessibleName: 'Login' }
};

function event(input: Omit<RawBrowserEvent, 'id' | 'pageId'> & { id?: string }): RawBrowserEvent {
  return { id: input.id ?? crypto.randomUUID(), pageId: 'page-1', ...input };
}

describe('user demo recorder', () => {
  it('creates a guarded capture script that strips password-like values in-page', () => {
    const script = createBrowserRecorderCaptureScript();
    expect(script).toContain(BROWSER_RECORDER_BINDING_NAME);
    expect(script).toContain("el.type === 'password'");
    expect(script).toContain("...(!secret ? { value:");
    expect(script).toContain('MutationObserver');
    expect(script).toContain('current.frameElement');
    expect(script).toContain('selectors.unshift(selector)');
  });

  it('defensively removes secret values from binding payloads', () => {
    const parsed = parseBrowserRecorderBindingPayload(JSON.stringify({
      type: 'change', timestamp: 10, url: 'https://example.com/login', target: passwordTarget,
      secret: true, value: 'must-not-cross-boundary'
    }));
    expect(parsed).toMatchObject({ type: 'change', secret: true });
    expect(parsed).not.toHaveProperty('value');
    expect(parseBrowserRecorderBindingPayload('{broken')).toBeUndefined();
    expect(parseBrowserRecorderBindingPayload(JSON.stringify({
      type: 'click', url: 'https://pay.example.com/',
      frame: { selectors: ['iframe[name="payment"]'] },
      target: { ...loginTarget, frame: { selectors: ['iframe[name="payment"]'] } }
    }))).toMatchObject({
      frame: { selectors: ['iframe[name="payment"]'] },
      target: { frame: { selectors: ['iframe[name="payment"]'] } }
    });
  });

  it('compresses incremental inputs, final selects, duplicate clicks and wait hints', () => {
    const compressed = compressRawBrowserEvents([
      event({ id: '1', timestamp: 1, type: 'change', url: 'https://example.com', target: usernameTarget, value: 'j' }),
      event({ id: '2', timestamp: 2, type: 'change', url: 'https://example.com', target: usernameTarget, value: 'jojo' }),
      event({ id: '3', timestamp: 3, type: 'click', url: 'https://example.com', target: loginTarget }),
      event({ id: '4', timestamp: 100, type: 'click', url: 'https://example.com', target: loginTarget }),
      event({ id: '5', timestamp: 200, type: 'wait', url: 'https://example.com', wait: { type: 'network_idle' } }),
      event({ id: '6', timestamp: 220, type: 'wait', url: 'https://example.com', wait: { type: 'network_idle', idleMs: 500 } })
    ]);
    expect(compressed.map((item) => item.id)).toEqual(['2', '3', '6']);
    expect(compressed[0]?.value).toBe('jojo');
  });

  it('does not merge identical controls from different frame paths', () => {
    const compressed = compressRawBrowserEvents([
      event({
        id: '1', timestamp: 1, type: 'change', url: 'https://example.com', value: 'one',
        target: { ...usernameTarget, frame: { selectors: ['iframe#one'] } }
      }),
      event({
        id: '2', timestamp: 2, type: 'change', url: 'https://example.com', value: 'two',
        target: { ...usernameTarget, frame: { selectors: ['iframe#two'] } }
      })
    ]);
    expect(compressed).toHaveLength(2);
  });

  it('keeps subframe navigation attached to the frame interaction instead of navigating the top page', () => {
    const frame = { selectors: ['iframe[name="payment"]'] };
    const recording = compileUserDemoRecording({
      id: 'frame-demo',
      name: 'Frame Demo',
      createdAt: '2026-08-25T00:00:00.000Z',
      events: [
        event({ id: '1', timestamp: 1, type: 'navigate', url: 'https://shop.example.com/checkout' }),
        event({ id: '2', timestamp: 2, type: 'click', url: 'https://pay.example.com/form', target: { ...loginTarget, frame } }),
        event({ id: '3', timestamp: 3, type: 'navigate', url: 'https://pay.example.com/complete', frame })
      ]
    });
    expect(recording.domains).toEqual(['pay.example.com', 'shop.example.com']);
    expect(recording.steps).toEqual([
      expect.objectContaining({ action: 'navigate', url: 'https://shop.example.com/checkout' }),
      expect.objectContaining({ action: 'click', target: expect.objectContaining({ frame }), wait: expect.objectContaining({ networkIdle: true }) })
    ]);
  });

  it('compiles a login demo into parameterized V2 steps without persisting secrets', () => {
    const recording = compileUserDemoRecording({
      id: 'login-demo',
      name: 'Login Demo',
      createdAt: '2026-08-25T00:00:00.000Z',
      events: [
        event({ id: '1', timestamp: 1, type: 'navigate', url: 'https://example.com/login' }),
        event({ id: '2', timestamp: 2, type: 'change', url: 'https://example.com/login', target: usernameTarget, value: 'jojo' }),
        event({ id: '3', timestamp: 3, type: 'change', url: 'https://example.com/login', target: passwordTarget, secret: true }),
        event({ id: '4', timestamp: 4, type: 'click', url: 'https://example.com/login', target: loginTarget }),
        event({ id: '5', timestamp: 5, type: 'wait', url: 'https://example.com/login', wait: { type: 'network_idle' } }),
        event({ id: '6', timestamp: 6, type: 'navigate', url: 'https://example.com/dashboard' })
      ]
    });
    expect(recording).toMatchObject({
      version: 2,
      domains: ['example.com'],
      params: [
        { name: 'username', secret: false },
        { name: 'password', secret: true }
      ],
      steps: [
        { action: 'navigate', url: 'https://example.com/login' },
        { action: 'type', value: '{{username}}' },
        { action: 'type', value: '{{password}}' },
        { action: 'click', wait: { networkIdle: true }, verify: { urlContains: '/dashboard' } }
      ]
    });
    expect(JSON.stringify(recording)).not.toContain('jojo');
  });

  it('turns a clicked download into one bound download step instead of clicking twice', () => {
    const target = {
      selector: '#export',
      fingerprint: { primarySelector: '#export', tag: 'button', accessibleName: 'Export' }
    };
    const recording = compileUserDemoRecording({
      id: 'download-demo',
      name: 'Download Demo',
      createdAt: '2026-08-25T00:00:00.000Z',
      events: [
        event({ id: '1', timestamp: 1, type: 'navigate', url: 'https://example.com/reports' }),
        event({ id: '2', timestamp: 2, type: 'click', url: 'https://example.com/reports', target }),
        event({
          id: '3', timestamp: 3, type: 'download', url: 'https://example.com/export', target,
          download: { suggestedFilename: 'monthly-report.xlsx' }
        })
      ]
    });
    expect(recording.steps).toHaveLength(2);
    expect(recording.steps[1]).toMatchObject({
      action: 'download', bind: 'monthly_report', verify: { downloadCompleted: true }
    });
    expect(recording.outputs).toEqual([{ name: 'monthly_report', type: 'file' }]);
  });

  it('marks popup-producing clicks so replay follows the new page', () => {
    const recording = compileUserDemoRecording({
      id: 'popup-demo',
      name: 'Popup Demo',
      createdAt: '2026-08-25T00:00:00.000Z',
      events: [
        event({ id: '1', timestamp: 1, type: 'navigate', url: 'https://example.com' }),
        event({ id: '2', timestamp: 2, type: 'click', url: 'https://example.com', target: loginTarget }),
        event({ id: '3', timestamp: 3, type: 'wait', url: 'https://example.com', wait: { type: 'new_page' } }),
        { ...event({ id: '4', timestamp: 4, type: 'click', url: 'https://example.com/popup', target: usernameTarget }), pageId: 'page-2' }
      ]
    });
    expect(recording.steps[1]).toMatchObject({ action: 'click', wait: { newPage: true } });
    expect(recording.steps[2]).toMatchObject({ action: 'click', target: { selector: '#username' } });
  });
});
