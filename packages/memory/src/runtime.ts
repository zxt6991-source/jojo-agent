import type {
  MemoryRecall,
  MemorySettings,
  MemorySnapshot,
  ProjectIdentity
} from '@desktop-agent/contracts';
import { DEFAULT_MEMORY_SETTINGS } from '@desktop-agent/contracts';
import type {
  MemoryCompactInput,
  MemoryCompactResult,
  MemoryRuntime,
  MemoryTurnSettledInput
} from '@desktop-agent/agent-runtime';
import { matchTriggeredRules } from './recall/trigger-matcher.js';
import { buildMemorySnapshot } from './snapshot/builder.js';
import type { MarkdownMemoryStore } from './store/markdown-store.js';

export class DurableMemoryRuntime implements MemoryRuntime {
  private readonly snapshots = new Map<string, MemorySnapshot>();
  private readonly triggered = new Map<string, Set<string>>();
  private readonly identities = new Map<string, ProjectIdentity | undefined>();

  constructor(
    readonly store: MarkdownMemoryStore,
    private settings: MemorySettings = DEFAULT_MEMORY_SETTINGS
  ) {}

  updateSettings(settings: MemorySettings): void {
    this.settings = structuredClone(settings);
    this.store.updateRecoveryRetentionDays(settings.recoveryRetentionDays);
    this.snapshots.clear();
  }

  async snapshot(input: {
    sessionId: string;
    operationId: string;
    projectIdentity?: ProjectIdentity;
    contextWindowTokens: number;
    signal: AbortSignal;
  }): Promise<MemorySnapshot> {
    const cached = this.snapshots.get(input.sessionId);
    if (cached) return cached;
    if (!this.settings.enabled) return buildMemorySnapshot({ scopes: [], contextWindowTokens: input.contextWindowTokens });
    const scopes = (await this.store.scopes(this.settings.projectEnabled ? input.projectIdentity : undefined))
      .filter((scope) => scope.kind === 'project' ? this.settings.projectEnabled : this.settings.globalEnabled);
    const scopeEntries = [];
    for (const scope of scopes) {
      if (input.signal.aborted) throw input.signal.reason;
      const version = await this.store.ensureIndexed(scope);
      scopeEntries.push({ scope, version, entries: (await this.store.listEntries(scope)).entries });
    }
    const snapshot = buildMemorySnapshot({
      scopes: scopeEntries,
      contextWindowTokens: input.contextWindowTokens,
      maxTokens: this.settings.maxSnapshotTokens,
      maxContextRatio: this.settings.maxContextRatio
    });
    this.snapshots.set(input.sessionId, snapshot);
    this.identities.set(input.sessionId, input.projectIdentity);
    return snapshot;
  }

  async recallTriggered(input: {
    sessionId: string;
    operationId: string;
    snapshotId: string;
    userText: string;
    projectIdentity?: ProjectIdentity;
  }): Promise<MemoryRecall[]> {
    if (!this.settings.enabled || !this.settings.autoRecall) return [];
    const snapshot = this.snapshots.get(input.sessionId);
    if (snapshot && snapshot.id !== input.snapshotId) return [];
    if (input.projectIdentity) this.identities.set(input.sessionId, input.projectIdentity);
    const scopes = (await this.store.scopes(input.projectIdentity ?? this.identities.get(input.sessionId)))
      .filter((scope) => scope.kind === 'project' ? this.settings.projectEnabled : this.settings.globalEnabled);
    const entries = (await Promise.all(scopes.map((scope) => this.store.listEntries(scope))))
      .flatMap((result) => result.entries);
    const triggered = this.triggered.get(input.sessionId) ?? new Set<string>();
    this.triggered.set(input.sessionId, triggered);
    return matchTriggeredRules(entries, input.userText, triggered);
  }

  async beforeCompact(input: MemoryCompactInput): Promise<MemoryCompactResult> {
    const identity = this.identities.get(input.sessionId);
    const scopes = (await this.store.scopes(identity))
      .filter((scope) => scope.kind === 'project' ? this.settings.projectEnabled : this.settings.globalEnabled);
    const currentVersions = Object.fromEntries(await Promise.all(scopes.map(async (scope) => [
      scope.id, await this.store.ensureIndexed(scope)
    ] as const)));
    const refreshSnapshot = Object.entries(currentVersions).some(([scopeId, version]) =>
      input.scopeVersions?.[scopeId] !== version
    );
    if (refreshSnapshot) this.snapshots.delete(input.sessionId);
    return {
      handoff: {
        openTasks: input.openTasks,
        decisions: input.decisions,
        memoryWrites: input.memoryWrites
      },
      refreshSnapshot
    };
  }

  async onTurnSettled(_input: MemoryTurnSettledInput): Promise<void> {
    // MVP intentionally does not perform automatic learning.
  }

  deleteSession(sessionId: string): void {
    this.snapshots.delete(sessionId);
    this.triggered.delete(sessionId);
    this.identities.delete(sessionId);
  }
}
