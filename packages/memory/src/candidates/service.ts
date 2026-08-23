import { createHash } from 'node:crypto';
import {
  CandidateExtractionResultSchema,
  MemoryCandidateReviewEditSchema,
  MemoryError,
  type CandidateExtractionResult,
  type MemoryCandidate,
  type MemoryCandidateReviewEdit,
  type MemorySettings,
  type ProjectIdentity
} from '@desktop-agent/contracts';
import { sanitizeMemoryContent } from '../security/sanitizer.js';
import { scanSecrets } from '../security/secret-scanner.js';
import type { MarkdownMemoryStore } from '../store/markdown-store.js';
import { createProjectIdentity } from '../identity.js';
import type { MemoryCandidateEvidence } from './evidence.js';

export interface MemoryCandidateStore {
  claimExtraction(operationId: string, sessionId: string, now?: number): Promise<boolean>;
  completeExtraction(operationId: string): Promise<void>;
  failExtraction(operationId: string, errorCode: string): Promise<void>;
  insert(candidate: MemoryCandidate): Promise<'created' | 'duplicate'>;
  get(id: string): Promise<MemoryCandidate | undefined>;
  list(state?: MemoryCandidate['state'], limit?: number): Promise<MemoryCandidate[]>;
  resolve(id: string, state: Exclude<MemoryCandidate['state'], 'pending'>, now?: number): Promise<boolean>;
  wasRejectedSince(fingerprint: string, since: number): Promise<boolean>;
  hasPendingFingerprint(fingerprint: string): Promise<boolean>;
  expire(now?: number): Promise<number>;
}

export type CandidateExtractor = (input: {
  sessionId: string;
  operationId: string;
  evidence: MemoryCandidateEvidence;
  maxCandidates: number;
  signal: AbortSignal;
}) => Promise<CandidateExtractionResult>;

export type CandidateLifecycleEvent = {
  event:
    | 'memory.candidate.eligibility_matched'
    | 'memory.candidate.extraction_started'
    | 'memory.candidate.created'
    | 'memory.candidate.deduplicated'
    | 'memory.candidate.rejected'
    | 'memory.candidate.expired'
    | 'memory.candidate.accept.requested'
    | 'memory.candidate.accepted'
    | 'memory.candidate.write_failed';
  operationId?: string;
  candidateId?: string;
  count?: number;
  warning?: string;
};

export type CandidateAcceptInput = {
  id: string;
  workingDirectory?: string;
  userConfirmed: boolean;
  edit?: MemoryCandidateReviewEdit;
};

const THIRTY_DAYS = 30 * 86_400_000;
const SEVEN_DAYS = 7 * 86_400_000;
const SENSITIVE_INFERENCE = /(?:race|ethnicity|religion|sexual orientation|medical diagnosis|政治倾向|宗教信仰|性取向|种族|疾病诊断)/iu;

function normalized(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

export function candidateFingerprint(input: Pick<MemoryCandidate, 'scope' | 'kind' | 'title' | 'content'>): string {
  return createHash('sha256').update([
    input.scope, input.kind, normalized(input.title), normalized(input.content)
  ].join('\0')).digest('hex');
}

function candidatePolicyDenied(...values: string[]): string | undefined {
  const sanitized = sanitizeMemoryContent(values.join('\n'));
  if (sanitized.suspicious) return 'Candidate resembles an instruction-injection payload.';
  if (scanSecrets(sanitized.content).length) return 'Candidate contains a secret-like value.';
  if (SENSITIVE_INFERENCE.test(sanitized.content)) return 'Candidate infers a sensitive personal trait.';
  return undefined;
}

export class MemoryCandidateService {
  private readonly reviewing = new Set<string>();

  constructor(
    readonly store: MarkdownMemoryStore,
    readonly candidates: MemoryCandidateStore,
    private readonly extractor: CandidateExtractor,
    private readonly emit: (event: CandidateLifecycleEvent) => void = () => undefined
  ) {}

  async extract(input: {
    sessionId: string;
    operationId: string;
    evidence: MemoryCandidateEvidence;
    identity?: ProjectIdentity;
    explicitMemoryIntent: boolean;
    settings: MemorySettings['suggestions'];
    signal: AbortSignal;
  }): Promise<number> {
    if (!await this.candidates.claimExtraction(input.operationId, input.sessionId)) return 0;
    this.emit({ event: 'memory.candidate.extraction_started', operationId: input.operationId });
    try {
      const extracted = CandidateExtractionResultSchema.parse(await this.extractor({
        sessionId: input.sessionId,
        operationId: input.operationId,
        evidence: input.evidence,
        maxCandidates: input.settings.maxPerTurn,
        signal: input.signal
      }));
      const globalScope = this.store.globalScope();
      const projectScope = input.identity ? this.store.projectScope(input.identity) : undefined;
      const scopes = [globalScope, ...(projectScope ? [projectScope] : [])];
      for (const scope of scopes) await this.store.ensureScope(scope);
      const active = (await Promise.all(scopes.map((scope) => this.store.listEntries(scope))))
        .flatMap((result) => result.entries);
      let created = 0;
      for (const item of extracted.candidates.slice(0, input.settings.maxPerTurn)) {
        if (item.scope === 'project' && !projectScope) continue;
        const denied = candidatePolicyDenied(
          item.title, item.content, item.rationale, ...item.tags, ...(item.ruleTriggers ?? [])
        );
        if (denied) {
          this.emit({ event: 'memory.candidate.deduplicated', operationId: input.operationId, warning: denied });
          continue;
        }
        const fingerprint = candidateFingerprint(item);
        const sameContent = active.find((entry) => normalized(entry.content) === normalized(item.content));
        if (sameContent || await this.candidates.hasPendingFingerprint(fingerprint)) {
          this.emit({ event: 'memory.candidate.deduplicated', operationId: input.operationId });
          continue;
        }
        if (!input.explicitMemoryIntent && await this.candidates.wasRejectedSince(fingerprint, Date.now() - SEVEN_DAYS)) {
          this.emit({ event: 'memory.candidate.deduplicated', operationId: input.operationId, warning: 'suppressed' });
          continue;
        }
        const sameTitle = active.find((entry) => normalized(entry.title ?? '') === normalized(item.title));
        const scopeId = item.scope === 'global' ? globalScope.id : projectScope!.id;
        const now = Date.now();
        const candidate: MemoryCandidate = {
          id: `memcand_${crypto.randomUUID().replace(/-/gu, '')}`,
          sessionId: input.sessionId,
          operationId: input.operationId,
          scopeId,
          scope: item.scope,
          kind: item.kind,
          title: item.title,
          content: item.content,
          rationale: item.rationale,
          confidence: input.evidence.externalContentPresent && item.confidence === 'high' ? 'medium' : item.confidence,
          tags: item.tags,
          suggestedTarget: item.suggestedTarget,
          ...(item.kind === 'rule' ? { rule: { ...(item.ruleTriggers ? { triggers: item.ruleTriggers } : {}) } } : {}),
          suggestedMutation: sameTitle ? {
            type: 'update', existingMemoryId: sameTitle.id, expectedHashAtProposal: sameTitle.contentHash
          } : { type: 'create' },
          provenance: [
            { source: 'user', verified: true },
            ...(input.evidence.finalOutcome ? [{
              source: 'assistant' as const,
              verified: !input.evidence.externalContentPresent
            }] : []),
            ...input.evidence.validatedToolFacts.map((fact) => ({ source: 'tool' as const, sourceId: fact.toolName, verified: true }))
          ],
          state: 'pending', fingerprint, createdAt: now, expiresAt: now + THIRTY_DAYS
        };
        if (await this.candidates.insert(candidate) === 'created') {
          created += 1;
          this.emit({ event: 'memory.candidate.created', operationId: input.operationId, candidateId: candidate.id });
        } else {
          this.emit({ event: 'memory.candidate.deduplicated', operationId: input.operationId });
        }
      }
      await this.candidates.completeExtraction(input.operationId);
      return created;
    } catch (error) {
      await this.candidates.failExtraction(input.operationId, 'memory_candidate_extraction_failed');
      throw error;
    }
  }

  async listPending(limit = 100): Promise<MemoryCandidate[]> {
    const expired = await this.candidates.expire();
    if (expired) this.emit({ event: 'memory.candidate.expired', count: expired });
    return this.candidates.list('pending', limit);
  }

  async reject(id: string): Promise<void> {
    if (this.reviewing.has(id)) throw new MemoryError('memory_candidate_invalid', 'Candidate review is already in progress.');
    const candidate = await this.candidates.get(id);
    if (!candidate) throw new MemoryError('memory_candidate_not_found', `Memory Candidate not found: ${id}`);
    if (!await this.candidates.resolve(id, 'rejected')) {
      throw new MemoryError('memory_candidate_invalid', 'Only pending candidates can be rejected.');
    }
    this.emit({ event: 'memory.candidate.rejected', candidateId: id });
  }

  async accept(input: CandidateAcceptInput): Promise<void> {
    if (this.reviewing.has(input.id)) throw new MemoryError('memory_candidate_invalid', 'Candidate review is already in progress.');
    this.reviewing.add(input.id);
    try { await this.acceptConfirmed(input); }
    finally { this.reviewing.delete(input.id); }
  }

  private async acceptConfirmed(input: CandidateAcceptInput): Promise<void> {
    if (!input.userConfirmed) throw new MemoryError('memory_candidate_policy_denied', 'Candidate acceptance requires explicit user confirmation.');
    this.emit({ event: 'memory.candidate.accept.requested', candidateId: input.id });
    const current = await this.candidates.get(input.id);
    if (!current) throw new MemoryError('memory_candidate_not_found', `Memory Candidate not found: ${input.id}`);
    if (current.state !== 'pending') throw new MemoryError('memory_candidate_invalid', 'Only pending candidates can be accepted.');
    if (current.expiresAt <= Date.now()) {
      await this.candidates.resolve(current.id, 'expired');
      throw new MemoryError('memory_candidate_expired', 'Memory Candidate has expired.');
    }
    const edit = MemoryCandidateReviewEditSchema.parse(input.edit ?? {});
    const title = edit.title ?? current.title;
    const content = edit.content ?? current.content;
    const kind = edit.kind ?? current.kind;
    const candidateScope = edit.scope ?? current.scope;
    const tags = edit.tags ?? current.tags;
    const target = edit.suggestedTarget ?? current.suggestedTarget;
    const triggers = edit.ruleTriggers ?? current.rule?.triggers;
    const denied = candidatePolicyDenied(title, content, ...tags, ...(triggers ?? []));
    if (denied) throw new MemoryError('memory_candidate_policy_denied', denied);
    const projectIdentity = candidateScope === 'project' && input.workingDirectory
      ? await createProjectIdentity(input.workingDirectory)
      : undefined;
    const scope = candidateScope === 'global'
      ? this.store.globalScope()
      : projectIdentity ? this.store.projectScope(projectIdentity) : undefined;
    if (!scope) throw new MemoryError('memory_scope_unavailable', 'Project Memory is unavailable.');
    await this.store.ensureScope(scope);
    const latestEntries = (await this.store.listEntries(scope)).entries;
    const alreadyWritten = latestEntries.find((entry) =>
      normalized(entry.title ?? '') === normalized(title) && normalized(entry.content) === normalized(content)
    );
    if (alreadyWritten) {
      if (!await this.candidates.resolve(current.id, 'accepted')) {
        throw new MemoryError('memory_candidate_invalid', 'Candidate state changed during acceptance.');
      }
      this.emit({ event: 'memory.candidate.accepted', candidateId: current.id });
      return;
    }
    let existingId: string | undefined;
    let path = target === 'index' ? 'MEMORY.md'
      : target === 'scratchpad' ? 'SCRATCHPAD.md'
        : `topics/${normalized(title).replace(/[^\p{Letter}\p{Number}]+/gu, '-').slice(0, 80) || 'memory'}.md`;
    const suggestedMutation = current.suggestedMutation;
    if (suggestedMutation.type === 'update') {
      const existing = latestEntries.find((entry) => entry.id === suggestedMutation.existingMemoryId);
      if (!existing || existing.contentHash !== suggestedMutation.expectedHashAtProposal) {
        this.emit({ event: 'memory.candidate.write_failed', candidateId: current.id, warning: 'memory_candidate_write_conflict' });
        throw new MemoryError('memory_candidate_write_conflict', 'Memory changed after this suggestion was created; review it again.');
      }
      existingId = existing.id;
      path = existing.sourceFile;
    }
    const document = await this.store.read(scope, path);
    try {
      await this.store.writeEntry({
        scope,
        kind,
        title,
        content,
        tags,
        target,
        expectedRevision: document.revision,
        sourceSessionId: current.sessionId,
        sourceOperationId: current.operationId,
        status: 'confirmed',
        confirmedBy: 'user',
        ...(kind === 'rule' ? {
          ruleMode: triggers?.length ? 'triggered' as const : 'always' as const,
          ...(triggers ? { triggers } : {})
        } : {}),
        ...(existingId ? { existingId } : {})
      });
      if (!await this.candidates.resolve(current.id, 'accepted')) {
        throw new MemoryError('memory_candidate_invalid', 'Candidate state changed during acceptance.');
      }
      this.emit({ event: 'memory.candidate.accepted', candidateId: current.id });
    } catch (error) {
      this.emit({ event: 'memory.candidate.write_failed', candidateId: current.id, warning: error instanceof Error ? error.message : String(error) });
      if (error instanceof MemoryError && error.code === 'memory_conflict') {
        throw new MemoryError('memory_candidate_write_conflict', error.message, error.details);
      }
      throw error;
    }
  }
}
