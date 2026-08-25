import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { migrateBrowserRecording, type BrowserRecordingDocument, type BrowserTarget } from '@desktop-agent/contracts';
import {
  BrowserReplayEngine,
  BrowserReplayJournalStore,
  BrowserSessionManager,
  finalizeBrowserRecording,
  hasValidBrowserRecordingHash,
  type BrowserDriver,
  type BrowserHealingPort,
  type BrowserPage,
  type BrowserReplayProgress,
  type BrowserReplayJournalEntry,
  type BrowserReplayJournalPort,
  type BrowserSession
} from '../src';

function recording(overrides: Partial<BrowserRecordingDocument> = {}): BrowserRecordingDocument {
  const migrated = migrateBrowserRecording({
    version: 1,
    id: 'login-demo',
    name: 'Login Demo',
    createdAt: '2026-08-25T00:00:00.000Z',
    params: [{ name: 'username' }],
    steps: [
      { action: 'open', url: 'https://example.com/login' },
      { action: 'type', selector: '#username', text: '{{username}}', fingerprint: { tag: 'input', fieldName: 'username' } },
      { action: 'click', selector: '#login', fingerprint: { tag: 'button', name: 'Login' } }
    ]
  });
  return finalizeBrowserRecording({ ...migrated, ...overrides });
}

function fakeBrowser() {
  let url = 'https://example.com/';
  const calls: string[] = [];
  const page = {
    async navigate(next: string) { url = next; calls.push(`navigate:${next}`); },
    async read() { return { url, title: 'Example', text: 'Dashboard ready' }; },
    async resolveTarget(target: BrowserTarget) {
      if (target.selector === '#username') return { selector: '[name="username"]', relocated: true, score: 120 };
      return target.selector ? { selector: target.selector, relocated: false } : undefined;
    },
    async click(target: { selector: string }) { calls.push(`click:${target.selector}`); url = 'https://example.com/dashboard'; },
    async hover() {},
    async type(target: { selector: string }, value: string) { calls.push(`type:${target.selector}:${value}`); },
    async press() {},
    async select() {},
    async wait() {},
    async screenshot() { return { mimeType: 'image/png' as const, data: new Uint8Array() }; },
    async getUrl() { return url; },
    async getTitle() { return 'Example'; }
  } as unknown as BrowserPage;
  const session = {
    async activePage() { return page; },
    async listPages() { return []; },
    async newPage() { return page; },
    async selectPage() {},
    async closePage() {},
    subscribe() { return () => undefined; },
    async close() {}
  } satisfies BrowserSession;
  return { page, session, calls, setUrl(value: string) { url = value; } };
}

describe('browser automation core', () => {
  it('migrates V1 into hashed V2 without losing target semantics', () => {
    const migrated = recording();
    expect(migrated).toMatchObject({
      version: 2,
      revision: 1,
      domains: ['example.com'],
      steps: [
        { id: 'step-1', action: 'navigate' },
        { id: 'step-2', action: 'type', target: { fingerprint: { fieldName: 'username' } } },
        { id: 'step-3', action: 'click', target: { fingerprint: { accessibleName: 'Login' } } }
      ]
    });
    expect(hasValidBrowserRecordingHash(migrated)).toBe(true);
  });

  it('replays deterministically, substitutes params, reports relocation and verifies the end state', async () => {
    const fixture = fakeBrowser();
    const progress: BrowserReplayProgress[] = [];
    const source = recording({ end: { urlContains: '/dashboard', textContains: 'Dashboard ready' } });
    const result = await new BrowserReplayEngine().replay(source, fixture.session, {
      params: { username: 'jojo' },
      onProgress: (event) => progress.push(event)
    });
    expect(result).toMatchObject({ success: true, relocated: true, finalUrl: 'https://example.com/dashboard' });
    expect(fixture.calls).toEqual([
      'navigate:https://example.com/login',
      'type:[name="username"]:jojo',
      'click:#login'
    ]);
    expect(progress).toContainEqual({ type: 'relocated', oldSelector: '#username', newSelector: '[name="username"]' });
  });

  it('preserves frame paths through target resolution and action dispatch', async () => {
    const fixture = fakeBrowser();
    const frame = { selectors: ['iframe[name="payment"]', 'iframe.confirmation'] };
    const resolvedTargets: BrowserTarget[] = [];
    fixture.page.resolveTarget = async (target) => {
      resolvedTargets.push(target);
      return { selector: target.selector!, relocated: false, ...(target.frame ? { frame: target.frame } : {}) };
    };
    const clicked: Array<{ selector: string; frame?: typeof frame }> = [];
    fixture.page.click = async (target) => { clicked.push(target); };
    const source = recording({
      steps: [{ id: 'confirm', action: 'click', target: { selector: '#confirm', frame } }]
    });

    const result = await new BrowserReplayEngine().replay(source, fixture.session, { params: { username: 'unused' } });

    expect(result.success, result.error).toBe(true);
    expect(resolvedTargets).toEqual([{ selector: '#confirm', frame }]);
    expect(clicked).toEqual([{ selector: '#confirm', relocated: false, frame }]);
  });

  it('stops when a redirect leaves the declared domain', async () => {
    const fixture = fakeBrowser();
    const originalClick = fixture.page.click.bind(fixture.page);
    fixture.page.click = async (target) => {
      await originalClick(target);
      fixture.setUrl('https://evil.example.net/steal');
    };
    const result = await new BrowserReplayEngine().replay(recording(), fixture.session, { params: { username: 'jojo' } });
    expect(result).toMatchObject({ success: false });
    expect(result.error).toMatch(/not declared/u);
  });

  it('journals effect dispatch and refuses to blindly repeat an unverified click after a crash', async () => {
    const fixture = fakeBrowser();
    let clicks = 0;
    fixture.page.click = async () => {
      clicks += 1;
      throw new Error('Execution context was destroyed after click.');
    };
    const entries: BrowserReplayJournalEntry[] = [];
    const journal: BrowserReplayJournalPort = {
      async append(entry) { entries.push(entry); },
      async read(runId) { return entries.filter((entry) => entry.runId === runId); }
    };
    const runId = 'brun_resume_guard_01';
    const first = await new BrowserReplayEngine().replay(recording(), fixture.session, {
      params: { username: 'jojo' }, journal, runId
    });
    expect(first.success).toBe(false);
    expect(clicks).toBe(1);
    expect(entries).toContainEqual(expect.objectContaining({
      stepId: 'step-3', state: 'step_effect_dispatched', action: 'click'
    }));

    const resumed = await new BrowserReplayEngine().replay(recording(), fixture.session, {
      params: { username: 'jojo' }, journal, runId, resume: true
    });
    expect(resumed).toMatchObject({ success: false, runId });
    expect(resumed.error).toMatch(/explicit confirmation/iu);
    expect(clicks).toBe(1);
  });

  it('skips journaled verified steps when resuming the same recording revision', async () => {
    const fixture = fakeBrowser();
    const entries: BrowserReplayJournalEntry[] = [];
    const journal: BrowserReplayJournalPort = {
      async append(entry) { entries.push(entry); },
      async read(runId) { return entries.filter((entry) => entry.runId === runId); }
    };
    const runId = 'brun_resume_verified_01';
    const first = await new BrowserReplayEngine().replay(recording(), fixture.session, {
      params: { username: 'jojo' }, journal, runId
    });
    expect(first.success).toBe(true);
    const callCount = fixture.calls.length;
    const resumed = await new BrowserReplayEngine().replay(recording(), fixture.session, {
      params: { username: 'jojo' }, journal, runId, resume: true
    });
    expect(resumed.success).toBe(true);
    expect(resumed.steps.every((step) => step.attempts === 0)).toBe(true);
    expect(fixture.calls).toHaveLength(callCount);
  });

  it('restores bound outputs from verified journal entries without repeating the effect', async () => {
    const fixture = fakeBrowser();
    let downloads = 0;
    fixture.page.download = async () => {
      downloads += 1;
      return { path: '/workspace/report.xlsx' };
    };
    const source = recording({
      outputs: [{ name: 'report', type: 'file' }],
      steps: [{
        id: 'download-report', action: 'download', bind: 'report',
        target: { selector: '#download' }, verify: { downloadCompleted: true }
      }]
    });
    const entries: BrowserReplayJournalEntry[] = [];
    const journal: BrowserReplayJournalPort = {
      async append(entry) { entries.push(entry); },
      async read(runId) { return entries.filter((entry) => entry.runId === runId); }
    };
    const runId = 'brun_resume_outputs_01';

    const first = await new BrowserReplayEngine().replay(source, fixture.session, {
      params: { username: 'jojo' }, journal, runId
    });
    const resumed = await new BrowserReplayEngine().replay(source, fixture.session, {
      params: { username: 'jojo' }, journal, runId, resume: true
    });

    expect(first.success, first.error).toBe(true);
    expect(first.outputs).toEqual({ report: { type: 'file', path: '/workspace/report.xlsx' } });
    expect(resumed.outputs).toEqual(first.outputs);
    expect(downloads).toBe(1);
    expect(entries).toContainEqual(expect.objectContaining({
      state: 'step_verified', output: { name: 'report', value: first.outputs.report }
    }));
  });

  it('persists bounded replay journal entries as isolated JSONL runs', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-browser-journal-'));
    try {
      const store = new BrowserReplayJournalStore(directory);
      const entry: BrowserReplayJournalEntry = {
        runId: 'brun_persisted_01', recordingId: 'login-demo', revision: 1,
        stepId: 'step-1', stepIndex: 1, action: 'click', state: 'step_effect_dispatched',
        attempt: 1, timestamp: '2026-08-25T00:00:00.000Z'
      };
      await store.append(entry);
      await expect(store.read(entry.runId)).resolves.toEqual([entry]);
      await expect(store.read('brun_missing_01')).resolves.toEqual([]);
      await expect(store.read('../outside')).rejects.toThrow(/Invalid browser replay run id/iu);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('self-heals only after deterministic target recovery fails, verifies, then persists with OCC', async () => {
    const fixture = fakeBrowser();
    fixture.page.read = async () => ({
      url: 'https://example.com/settings', title: 'Settings',
      elements: [
        { selector: 'button[data-testid="save"]', tag: 'button', role: 'button', accessibleName: 'Save Changes', visible: true },
        { selector: 'button.secondary', tag: 'button', role: 'button', accessibleName: 'Cancel', visible: true }
      ]
    });
    fixture.page.resolveTarget = async (target) => target.selector === 'button[data-testid="save"]'
      ? { selector: target.selector, relocated: false }
      : undefined;
    const healingPort: BrowserHealingPort = {
      heal: vi.fn(async () => ({ selector: 'button[data-testid="save"]', confidence: 0.94, reason: 'semantic match' }))
    };
    const source = recording({
      steps: [{
        id: 'save', action: 'click', target: { selector: '#save-button', fingerprint: { tag: 'button', accessibleName: 'Save' } },
        verify: { urlContains: '/dashboard' }
      }]
    });
    const save = vi.fn(async (document: BrowserRecordingDocument) => ({ ...document, revision: document.revision + 1 }));
    const progress: BrowserReplayProgress[] = [];
    const result = await new BrowserReplayEngine().replay(source, fixture.session, {
      maxRetries: 0,
      params: { username: 'jojo' },
      healingPort,
      recordingStore: { list: async () => [], get: async () => source, save, delete: async () => undefined },
      onProgress: (event) => progress.push(event)
    });
    expect(result).toMatchObject({
      success: true,
      selfHealed: true,
      healRecords: [{ stepId: 'save', selector: 'button[data-testid="save"]', confidence: 0.94, persisted: true }]
    });
    expect(fixture.calls).toContain('click:button[data-testid="save"]');
    expect(progress).toContainEqual({ type: 'heal_start', round: 1 });
    expect(progress).toContainEqual({ type: 'heal_success', selector: 'button[data-testid="save"]' });
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ steps: [expect.objectContaining({ target: expect.objectContaining({ selector: 'button[data-testid="save"]' }) })] }),
      { expectedRevision: source.revision, expectedHash: source.contentHash }
    );
  });

  it('rejects a healed selector outside the DOM digest and never dispatches the action', async () => {
    const fixture = fakeBrowser();
    fixture.page.read = async () => ({
      url: 'https://example.com/settings', title: 'Settings',
      elements: [{ selector: 'button.secondary', tag: 'button', accessibleName: 'Cancel', visible: true }]
    });
    fixture.page.resolveTarget = async () => undefined;
    const source = recording({
      steps: [{ id: 'save', action: 'click', target: { selector: '#save-button' } }]
    });
    const result = await new BrowserReplayEngine().replay(source, fixture.session, {
      maxRetries: 0,
      params: { username: 'jojo' },
      healingPort: { heal: async () => ({ selector: '#invented', confidence: 0.99 }) }
    });
    expect(result).toMatchObject({ success: false, selfHealed: false });
    expect(result.error).toMatch(/outside the unique DOM candidate set/iu);
    expect(fixture.calls.some((call) => call.startsWith('click:'))).toBe(false);
  });

  it('does not persist a heal proposal when its step verification fails', async () => {
    const fixture = fakeBrowser();
    fixture.page.read = async () => ({
      url: 'https://example.com/settings', title: 'Settings',
      elements: [{ selector: '#new-save', tag: 'button', accessibleName: 'Save', visible: true }]
    });
    fixture.page.resolveTarget = async (target) => target.selector === '#new-save'
      ? { selector: '#new-save', relocated: false }
      : undefined;
    const source = recording({
      steps: [{ id: 'save', action: 'click', target: { selector: '#old-save' }, verify: { urlContains: '/never' } }]
    });
    const save = vi.fn();
    const result = await new BrowserReplayEngine().replay(source, fixture.session, {
      maxRetries: 0,
      params: { username: 'jojo' },
      healingPort: { heal: async () => ({ selector: '#new-save', confidence: 0.9 }) },
      recordingStore: { list: async () => [], get: async () => source, save, delete: async () => undefined }
    });
    expect(result).toMatchObject({ success: false, selfHealed: false });
    expect(save).not.toHaveBeenCalled();
  });

  it('opens driver sessions lazily and reuses them until close', async () => {
    const close = vi.fn(async () => undefined);
    const session = { ...fakeBrowser().session, close };
    const openSession = vi.fn(async () => session);
    const manager = new BrowserSessionManager({ openSession } satisfies BrowserDriver);
    expect(openSession).not.toHaveBeenCalled();
    expect(await manager.acquire({ sessionId: 's1' })).toBe(session);
    expect(await manager.acquire({ sessionId: 's1' })).toBe(session);
    expect(openSession).toHaveBeenCalledTimes(1);
    await manager.close('s1');
    expect(close).toHaveBeenCalledTimes(1);
  });
});
