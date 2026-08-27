import type {
  MemoryRecall,
  MemorySettings,
  MemorySnapshot,
  MemoryWarning,
  ProjectIdentity
} from '@desktop-agent/contracts';
import { DEFAULT_MEMORY_SETTINGS, MemoryError } from '@desktop-agent/contracts';
import type {
  MemoryCompactInput,
  MemoryCompactResult,
  MemoryRuntime,
  MemoryTurnSettledInput
} from '@desktop-agent/agent-runtime/memory';
import { matchTriggeredRules } from './recall/trigger-matcher.js';
import { buildMemorySnapshot } from './snapshot/builder.js';
import type { MarkdownMemoryStore } from './store/markdown-store.js';
import { extractMemoryToolHandoff, extractScratchpadHandoff, runtimeItems } from './compaction/extractor.js';
import { buildMemoryHandoff } from './compaction/handoff.js';
import { evaluateSnapshotRefresh } from './compaction/refresh-policy.js';
import { evaluateCandidateEligibility } from './candidates/eligibility.js';
import { buildCandidateEvidence, summarizeTurnTools } from './candidates/evidence.js';
import type { CandidateLifecycleEvent, MemoryCandidateService } from './candidates/service.js';

export class DurableMemoryRuntime implements MemoryRuntime {
  private readonly snapshots = new Map<string, MemorySnapshot>();
  private readonly triggered = new Map<string, Set<string>>();
  private readonly identities = new Map<string, ProjectIdentity | undefined>();
  private readonly candidateRequests = new Map<string, number[]>();

  constructor(
    readonly store: MarkdownMemoryStore,
    private settings: MemorySettings = DEFAULT_MEMORY_SETTINGS,
    private readonly candidateService?: MemoryCandidateService,
    private readonly emitCandidate: (event: CandidateLifecycleEvent) => void = () => undefined
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
    if (input.signal.aborted) throw input.signal.reason;
    const identity = input.projectIdentity ?? this.identities.get(input.sessionId);
    if (input.projectIdentity) this.identities.set(input.sessionId, input.projectIdentity);
    const scopes = this.settings.enabled
      ? (await this.store.scopes(this.settings.projectEnabled ? identity : undefined))
        .filter((scope) => scope.kind === 'project' ? this.settings.projectEnabled : this.settings.globalEnabled)
      : [];
    const project = scopes.find((scope) => scope.kind === 'project');
    const scratchpad = project
      ? extractScratchpadHandoff((await this.store.read(project, 'SCRATCHPAD.md')).content)
      : { openTasks: [], decisions: [] };
    const sourceTimestamp = input.messagesToSummarize.at(-1)?.createdAt;
    const handoffCreatedAt = sourceTimestamp ? Date.parse(sourceTimestamp) : Number.NaN;
    const handoff = buildMemoryHandoff({
      compact: input,
      openTasks: [...scratchpad.openTasks, ...runtimeItems(input.runtimeOpenTasks)],
      decisions: [...scratchpad.decisions, ...runtimeItems(input.runtimeDecisions)],
      memoryWrites: extractMemoryToolHandoff(input.memoryToolEvents),
      ...(Number.isFinite(handoffCreatedAt) ? { createdAt: handoffCreatedAt } : {})
    });
    const warnings: MemoryWarning[] = [];
    if (project && (handoff.openTasks.length || handoff.decisions.length || handoff.memoryWrites.length)) {
      try {
        await this.store.appendDailyHandoff(project, handoff);
      } catch (error) {
        warnings.push({
          code: error instanceof MemoryError && error.code === 'memory_handoff_conflict'
            ? 'memory_handoff_conflict'
            : 'memory_handoff_failed',
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
    const currentVersions = Object.fromEntries(await Promise.all(scopes.map(async (scope) => [
      scope.id, await this.store.ensureIndexed(scope)
    ] as const)));
    const refresh = evaluateSnapshotRefresh(input.currentSnapshotScopeVersions ?? {}, currentVersions);
    warnings.push(...refresh.warnings);
    const refreshSnapshot = refresh.refreshSnapshot;
    if (refreshSnapshot) this.snapshots.delete(input.sessionId);
    return {
      handoff,
      refreshSnapshot,
      currentScopeVersions: currentVersions,
      ...(warnings.length ? { warnings } : {})
    };
  }

  async onTurnSettled(input: MemoryTurnSettledInput): Promise<void> {
    if (!this.settings.enabled || !this.settings.suggestions.enabled || !this.candidateService) return;
    if (!this.settings.suggestions.providerId || !this.settings.suggestions.model) return;
    const signal = input.signal ?? new AbortController().signal;
    const toolEvents = summarizeTurnTools(input.messages ?? [], input.userText);
    const eligibility = evaluateCandidateEligibility({
      userText: input.userText,
      ...(input.assistantText ? { assistantText: input.assistantText } : {}),
      toolEvents,
      minScore: this.settings.suggestions.minEligibilityScore
    });
    if (!eligibility.eligible || signal.aborted) return;
    const now = Date.now();
    const recent = (this.candidateRequests.get(input.sessionId) ?? []).filter((time) => time > now - 60_000);
    if (recent.length >= 6) return;
    recent.push(now);
    this.candidateRequests.set(input.sessionId, recent);
    this.emitCandidate({
      event: 'memory.candidate.eligibility_matched',
      operationId: input.operationId,
      warning: `score=${eligibility.score}`
    });
    const evidence = buildCandidateEvidence({
      userText: input.userText,
      ...(input.assistantText ? { assistantText: input.assistantText } : {}),
      toolEvents,
      ...(input.projectIdentity ? { projectIdentity: input.projectIdentity } : {}),
      evidenceMaxTokens: this.settings.suggestions.evidenceMaxTokens,
      hadCorrection: eligibility.signals.hadUserCorrection,
      hadDecision: eligibility.signals.hadDesignDecision
    });
    await this.candidateService.extract({
      sessionId: input.sessionId,
      operationId: input.operationId,
      evidence,
      ...(input.projectIdentity ? { identity: input.projectIdentity } : {}),
      explicitMemoryIntent: eligibility.signals.hadExplicitMemoryIntent,
      settings: this.settings.suggestions,
      signal
    });
  }

  deleteSession(sessionId: string): void {
    this.snapshots.delete(sessionId);
    this.triggered.delete(sessionId);
    this.identities.delete(sessionId);
    this.candidateRequests.delete(sessionId);
  }
}
