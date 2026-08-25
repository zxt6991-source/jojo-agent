import path from 'node:path';
import {
  slugifyBrowserRecordingName,
  type BrowserRecordingDocument,
  type BrowserRecordingStep
} from '@desktop-agent/contracts';
import { BrowserAutomationError } from '../errors';
import type { BrowserRecordingWriteExpectation } from '../ports/browser-recording-store';
import { BrowserRecordingStore } from './file-store';
import type { BrowserRecordingTrustStore } from './trust';

export type BrowserRecordingRegistrySource = 'builtin' | 'user' | 'project';
export type BrowserRecordingTrustState = 'not_required' | 'trusted' | 'untrusted';

export type BrowserRecordingEffectSummary = {
  domains: string[];
  effects: string[];
  highRisk: boolean;
};

export type BrowserRecordingRegistryEntry = {
  recording: BrowserRecordingDocument;
  source: BrowserRecordingRegistrySource;
  trust: BrowserRecordingTrustState;
  effectSummary: BrowserRecordingEffectSummary;
  overriddenSources: BrowserRecordingRegistrySource[];
  filename?: string;
};

export type BrowserRecordingRegistryOptions = {
  userDirectory: string;
  trustStore: BrowserRecordingTrustStore;
  legacyUserDirectory?: string;
  builtins?: BrowserRecordingDocument[];
};

const HIGH_RISK_ACTIONS = new Set<BrowserRecordingStep['action']>([
  'click', 'type', 'press', 'select', 'upload', 'download'
]);

export function browserRecordingEffectSummary(recording: BrowserRecordingDocument): BrowserRecordingEffectSummary {
  const effects = [...new Set(recording.steps.map((step) => {
    if (step.action === 'type') {
      const secret = recording.params.some((param) => param.secret && step.value?.includes(`{{${param.name}}}`));
      return secret ? 'type credentials' : 'type text';
    }
    if (step.action === 'download') return `download${step.bind ? ` ${step.bind}` : ''}`;
    if (step.action === 'upload') return 'upload file';
    if (step.action === 'navigate') return 'navigate';
    return step.action;
  }))];
  return {
    domains: [...recording.domains],
    effects,
    highRisk: recording.steps.some((step) => HIGH_RISK_ACTIONS.has(step.action))
  };
}

export class BrowserRecordingRegistry {
  private readonly userStore: BrowserRecordingStore;
  private readonly legacyUserStore: BrowserRecordingStore | undefined;

  constructor(private readonly options: BrowserRecordingRegistryOptions) {
    this.userStore = new BrowserRecordingStore(options.userDirectory);
    this.legacyUserStore = options.legacyUserDirectory && path.resolve(options.legacyUserDirectory) !== path.resolve(options.userDirectory)
      ? new BrowserRecordingStore(options.legacyUserDirectory)
      : undefined;
  }

  get userDirectory(): string { return this.userStore.directory; }

  projectDirectoryFor(workingDirectory: string): string {
    return this.projectStore(workingDirectory).directory;
  }

  async list(workingDirectory?: string): Promise<BrowserRecordingRegistryEntry[]> {
    const entries = new Map<string, BrowserRecordingRegistryEntry>();
    for (const recording of this.options.builtins ?? []) this.overlay(entries, recording, 'builtin', 'not_required');
    if (this.legacyUserStore) {
      for (const recording of await this.legacyUserStore.list()) {
        if (recording.scope === 'user') this.overlay(entries, recording, 'user', 'not_required', await this.legacyUserStore.existingRecordingPath(recording.id));
      }
    }
    for (const recording of await this.userStore.list()) {
      if (recording.scope === 'user') this.overlay(entries, recording, 'user', 'not_required', await this.userStore.existingRecordingPath(recording.id));
    }
    if (workingDirectory) {
      const projectStore = this.projectStore(workingDirectory);
      for (const recording of await projectStore.list()) {
        if (recording.scope !== 'project') continue;
        const filename = await projectStore.existingRecordingPath(recording.id);
        const trusted = await this.options.trustStore.isTrusted(filename, recording.contentHash);
        this.overlay(entries, recording, 'project', trusted ? 'trusted' : 'untrusted', filename);
      }
    }
    return [...entries.values()].sort((left, right) => left.recording.id.localeCompare(right.recording.id));
  }

  async get(id: string, workingDirectory?: string): Promise<BrowserRecordingRegistryEntry> {
    const entry = (await this.list(workingDirectory)).find((candidate) => candidate.recording.id === id);
    if (!entry) throw new BrowserAutomationError('browser_recording_not_found', `Browser recording does not exist: ${id}`);
    return entry;
  }

  async getExecutable(id: string, workingDirectory?: string): Promise<BrowserRecordingRegistryEntry> {
    const entry = await this.get(id, workingDirectory);
    if (entry.source === 'project' && entry.trust !== 'trusted' && entry.effectSummary.highRisk) {
      throw new BrowserAutomationError(
        'browser_recording_untrusted',
        `Project browser recording ${id} contains high-risk effects and must be trusted before replay.`,
        { id, contentHash: entry.recording.contentHash, effects: entry.effectSummary.effects }
      );
    }
    return entry;
  }

  async save(
    document: BrowserRecordingDocument,
    workingDirectory?: string,
    expectation?: BrowserRecordingWriteExpectation
  ): Promise<BrowserRecordingDocument> {
    if (document.scope === 'project') {
      if (!workingDirectory) throw new BrowserAutomationError('browser_recording_invalid', 'Project recording writes require a working directory.');
      const existing = await this.get(document.id, workingDirectory).catch(() => undefined);
      if (existing?.source === 'project' && existing.trust !== 'trusted') {
        throw new BrowserAutomationError('browser_recording_untrusted', `Project browser recording ${document.id} must be trusted before it can be updated.`);
      }
      return this.projectStore(workingDirectory).save(document, expectation);
    }
    const existing = await this.get(document.id, workingDirectory).catch(() => undefined);
    if (existing?.source === 'user' && existing.filename && this.legacyUserStore
      && path.resolve(path.dirname(existing.filename)) === path.resolve(this.legacyUserStore.directory)) {
      return this.legacyUserStore.save(document, expectation);
    }
    return this.userStore.save({ ...document, scope: 'user' }, expectation);
  }

  async delete(id: string, workingDirectory?: string): Promise<BrowserRecordingRegistrySource> {
    const entry = await this.get(id, workingDirectory);
    if (entry.source === 'builtin' || !entry.filename) {
      throw new BrowserAutomationError('browser_permission_denied', `Builtin browser recording ${id} cannot be deleted.`);
    }
    const store = entry.source === 'project'
      ? this.projectStore(workingDirectory!)
      : this.storeForUserFilename(entry.filename);
    await store.delete(id);
    await this.options.trustStore.revoke(entry.filename);
    return entry.source;
  }

  async allocateUserId(name: string, workingDirectory?: string): Promise<string> {
    const base = slugifyBrowserRecordingName(name);
    const existing = new Set((await this.list(workingDirectory)).map((entry) => entry.recording.id));
    if (!existing.has(base)) return base;
    for (let index = 2; index < 1_000; index += 1) {
      const suffix = `-${index}`;
      const candidate = `${base.slice(0, Math.max(1, 80 - suffix.length))}${suffix}`;
      if (!existing.has(candidate)) return candidate;
    }
    throw new BrowserAutomationError('browser_recording_invalid', 'Could not allocate a unique browser recording id.');
  }

  async trustProject(id: string, workingDirectory: string): Promise<BrowserRecordingRegistryEntry> {
    const entry = await this.get(id, workingDirectory);
    if (entry.source !== 'project' || !entry.filename) {
      throw new BrowserAutomationError('browser_recording_invalid', `Browser recording ${id} is not project-scoped.`);
    }
    await this.options.trustStore.trust(entry.filename, entry.recording.contentHash);
    return { ...entry, trust: 'trusted' };
  }

  async revokeProjectTrust(id: string, workingDirectory: string): Promise<BrowserRecordingRegistryEntry> {
    const entry = await this.get(id, workingDirectory);
    if (entry.source !== 'project' || !entry.filename) {
      throw new BrowserAutomationError('browser_recording_invalid', `Browser recording ${id} is not project-scoped.`);
    }
    await this.options.trustStore.revoke(entry.filename);
    return { ...entry, trust: 'untrusted' };
  }

  private projectStore(workingDirectory: string): BrowserRecordingStore {
    return new BrowserRecordingStore(path.join(path.resolve(workingDirectory), '.jojo', 'browser-recordings'));
  }

  private storeForUserFilename(filename: string): BrowserRecordingStore {
    return this.legacyUserStore && path.resolve(path.dirname(filename)) === path.resolve(this.legacyUserStore.directory)
      ? this.legacyUserStore
      : this.userStore;
  }

  private overlay(
    entries: Map<string, BrowserRecordingRegistryEntry>,
    recording: BrowserRecordingDocument,
    source: BrowserRecordingRegistrySource,
    trust: BrowserRecordingTrustState,
    filename?: string
  ): void {
    const previous = entries.get(recording.id);
    entries.set(recording.id, {
      recording,
      source,
      trust,
      effectSummary: browserRecordingEffectSummary(recording),
      overriddenSources: previous ? [...new Set([...previous.overriddenSources, previous.source])] : [],
      ...(filename ? { filename } : {})
    });
  }
}
