import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { z } from 'zod';
import { normalizeContextBlocks, ProjectIdentitySchema, SubAgentMemoryBindingSchema, WorkflowMemoryBindingSchema, TeamMemberMemoryBindingSchema, SubAgentProfileSchema } from '@desktop-agent/contracts';
import { ExecutionScopeSchema } from '@desktop-agent/contracts/runtime';
import { createIterationBudgetPolicy } from '@desktop-agent/agent';
import type { RunBudget } from '../public/run.js';
import type { ExecutionInstructionBlock, OperationExecutionSnapshotV1, RuntimeExecutionSummary } from '../public/execution.js';
import type { OperationMeta } from './meta.js';
import type { OperationState } from './state.js';

export const MAX_OPERATION_META_BYTES = 768 * 1024;
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
export function executionError(code = 'runtime_execution_snapshot_invalid', path = 'execution'): never {
  throw Object.assign(new Error(`${code}: ${path}`), { code });
}
export function stableExecutionJSON(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}
export function executionFingerprint(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableExecutionJSON(value)).digest('hex')}`;
}
export function instructionContentHash(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}
function bytes(value: unknown, max: number, path: string): void {
  if (Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8') > max) {
    executionError('runtime_execution_snapshot_too_large', path);
  }
}
const text = (max: number) => z.string().min(1).refine(value => !value.includes('\0') && Buffer.byteLength(value) <= max);
const id = text(512);
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const project = ProjectIdentitySchema.strict().extend({ canonicalPath: text(16 * 1024), displayName: id });
const block = z.object({ id, source: id, kind: z.literal('instruction'), content: z.string(), priority: z.number().finite(), sourceFingerprint: hash, contentHash: hash }).strict();
const budgetSchema = z.object({ maxIterations: positive, contextWindowTokens: positive, maxOutputTokens: positive, allowPartialOnLimit: z.boolean() }).strict()
  .refine(value => value.maxOutputTokens < value.contextWindowTokens);
const schema = z.object({
  schemaVersion: z.literal(1), capturedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  origin: z.enum(['public-runtime', 'trusted-harness']), executionScope: ExecutionScopeSchema,
  actor: z.object({ kind: z.enum(['main', 'subagent', 'workflow', 'team_member', 'channel_user']), id: id.optional(), profile: SubAgentProfileSchema.optional() }).strict(),
  trigger: z.object({ kind: z.enum(['user', 'api', 'scheduler', 'workflow', 'subagent', 'team_member', 'resume', 'channel_message']), id: id.optional() }).strict().optional(),
  workflow: z.object({ id, runId: id.optional(), stepId: id.optional() }).strict().optional(),
  team: z.object({ id, memberId: id, taskId: id.optional() }).strict().optional(),
  providerBinding: z.object({ providerId: id, model: id, configurationFingerprint: hash }).strict(),
  budget: budgetSchema,
  instructions: z.object({ requested: z.array(z.string()).max(128), contributed: z.array(block).max(128), compositionVersion: z.literal(1), fingerprint: hash }).strict(),
  runContext: z.object({ executionPolicyFingerprint: hash, projectIdentity: project.optional(), memoryBinding: z.union([
    SubAgentMemoryBindingSchema.extend({ projectIdentity: project.optional() }),
    WorkflowMemoryBindingSchema.extend({ projectIdentity: project.optional() }),
    TeamMemberMemoryBindingSchema.extend({ projectIdentity: project.optional() })
  ]).optional() }).strict()
}).strict();

/** Bounded JSON traversal before recursive schemas; diagnostics never echo values. */
function boundedTree(value: unknown, depth = 0, count = { nodes: 0 }): void {
  if (++count.nodes > 4096 || depth > 16) executionError('runtime_execution_snapshot_too_large');
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (/^(api[_-]?key|authorization|password|secret|token|cookie|headers|env)$/iu.test(key)) executionError();
      boundedTree(child, depth + 1, count);
    }
  }
}
export function normalizeExecutionBudget(input: { [K in keyof RunBudget]?: RunBudget[K] | undefined } = {}): Required<RunBudget> {
  for (const key of ['maxIterations', 'contextWindowTokens', 'maxOutputTokens'] as const) {
    if (input[key] !== undefined && !positive.safeParse(input[key]).success) executionError(undefined, `budget.${key}`);
  }
  const budget = {
    contextWindowTokens: input.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
    maxOutputTokens: input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    allowPartialOnLimit: input.allowPartialOnLimit ?? false,
    maxIterations: createIterationBudgetPolicy(Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))).runLimit
  };
  if (!budgetSchema.safeParse(budget).success) executionError(undefined, 'budget');
  return budget;
}
export function executionInstructions(requested: string[], contributed: ExecutionInstructionBlock[]): OperationExecutionSnapshotV1['instructions'] {
  if (!Array.isArray(requested) || !requested.every(value => typeof value === 'string') || !Array.isArray(contributed)
    || !contributed.every(value => block.safeParse(value).success)) executionError(undefined, 'instructions');
  const instructions = { requested: structuredClone(requested), contributed: normalizeContextBlocks(structuredClone(contributed)), compositionVersion: 1 as const };
  return { ...instructions, fingerprint: executionFingerprint(instructions) };
}
export function parseExecutionSnapshot(value: unknown): OperationExecutionSnapshotV1 {
  boundedTree(value);
  if (value === undefined) executionError();
  bytes(value, 512 * 1024, 'execution');
  if (!value || typeof value !== 'object' || !('schemaVersion' in value)) executionError();
  if (value.schemaVersion !== 1) executionError('runtime_execution_snapshot_version_unsupported', 'schemaVersion');
  const result = schema.safeParse(value);
  if (!result.success) executionError();
  const snapshot = result.data;
  if (snapshot.executionScope.kind === 'workspace') {
    if (!text(16 * 1024).safeParse(snapshot.executionScope.workingDirectory).success) executionError(undefined, 'executionScope');
  } else if (snapshot.executionScope.kind === 'custom') bytes(snapshot.executionScope.data, 16 * 1024, 'executionScope.data');
  for (const [name, part] of Object.entries({ workflow: snapshot.workflow, team: snapshot.team, memoryBinding: snapshot.runContext.memoryBinding })) {
    if (part) bytes(part, 16 * 1024, name);
  }
  const instructions = snapshot.instructions;
  assertPersistableInstructions([...instructions.requested, ...instructions.contributed.map(block => block.content)]);
  for (const [name, contents] of [['requested', instructions.requested], ['contributed', instructions.contributed.map(item => item.content)]] as const) {
    let total = 0;
    for (const content of contents) { bytes(content, 32 * 1024, name); total += Buffer.byteLength(content); }
    if (total > 192 * 1024) executionError('runtime_execution_snapshot_too_large', name);
  }
  const identities = new Set<string>();
  for (const item of instructions.contributed) {
    const key = stableExecutionJSON([item.kind, item.source, item.id]);
    if (identities.has(key) || instructionContentHash(item.content) !== item.contentHash) executionError(undefined, 'instructions.contributed');
    identities.add(key);
  }
  const { fingerprint, ...parts } = instructions;
  if (executionFingerprint(parts) !== fingerprint) executionError(undefined, 'instructions.fingerprint');
  return snapshot as OperationExecutionSnapshotV1;
}
export function validateOperationExecution(meta: OperationMeta, state?: OperationState): void {
  bytes(meta, MAX_OPERATION_META_BYTES, 'meta');
  if (meta.execution === undefined) return;
  const snapshot = parseExecutionSnapshot(meta.execution);
  if (snapshot.providerBinding.providerId !== meta.providerId || snapshot.providerBinding.model !== meta.model
    || snapshot.budget.maxIterations !== meta.maxIterations) executionError(undefined, 'meta');
  for (const value of Object.values(meta.config ?? {})) {
    if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) executionError(undefined, 'config');
  }
  for (const key of ['maxWallTimeMs', 'maxTotalTokens', 'maxCostUsd', 'maxToolCalls']) {
    const value = meta.config?.[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) executionError(undefined, 'config');
  }
  for (const key of ['absoluteIterationLimit', 'initialIterationLimit', 'maxCyclePeriod', 'requiredCycleRepeats', 'maxIdenticalToolCalls', 'recentIterationWindow']) {
    const value = meta.config?.[key];
    if (value !== undefined && !positive.safeParse(value).success) executionError(undefined, 'config');
  }
  if (typeof meta.config?.initialIterationLimit === 'number' && meta.config.initialIterationLimit > meta.maxIterations) executionError(undefined, 'config');
  if (typeof meta.config?.absoluteIterationLimit === 'number' && meta.config.absoluteIterationLimit < meta.maxIterations) executionError(undefined, 'config');
  if (meta.config?.dynamicIterationBudget !== undefined && typeof meta.config.dynamicIterationBudget !== 'boolean') executionError(undefined, 'config');
  if (state && (state.operationId !== meta.id || state.lane !== meta.lane)) executionError(undefined, 'state');
  if (state?.phase === 'model_pending' && (state.request.providerId !== meta.providerId || state.request.model !== meta.model
    || state.request.maxOutputTokens !== snapshot.budget.maxOutputTokens)) executionError(undefined, 'state.request');
  if (state && 'progress' in state && state.progress.iterationLimit !== undefined
    && (!Number.isSafeInteger(state.progress.iterationLimit) || state.progress.iterationLimit > meta.maxIterations)) executionError(undefined, 'state.progress');
}
export function executionSummary(value: unknown): RuntimeExecutionSummary {
  const { schemaVersion, executionScope, actor, trigger, workflow, team, providerBinding, budget, runContext, instructions } = parseExecutionSnapshot(value);
  return { schemaVersion, executionScope, actor, ...(trigger ? { trigger } : {}), ...(workflow ? { workflow } : {}), ...(team ? { team } : {}), providerBinding, budget, runContext, instructionFingerprint: instructions.fingerprint };
}
export async function validateExecutionWorkspace(snapshot: OperationExecutionSnapshotV1): Promise<void> {
  if (snapshot.executionScope.kind !== 'workspace') return;
  try {
    const directory = snapshot.executionScope.workingDirectory;
    if (!(await stat(directory)).isDirectory()) executionError('runtime_resume_scope_changed');
    const canonical = await realpath(directory);
    if (snapshot.runContext.projectIdentity && canonical !== snapshot.runContext.projectIdentity.canonicalPath) executionError('runtime_resume_scope_changed');
  } catch { executionError('runtime_resume_scope_changed'); }
}

/** Only whitelist semantic fields. Credentials and discovery timestamps never enter the digest. */
export function describeProviderConfiguration(config: {
  id: string; protocol: string; baseUrl: string; models?: import('@desktop-agent/contracts').ModelConfig[];
}, model: string): import('../public/execution.js').RuntimeProviderBinding {
  let endpoint: URL;
  try { endpoint = new URL(config.baseUrl); } catch { executionError(undefined, 'provider.endpoint'); }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) executionError(undefined, 'provider.endpoint');
  const configured = config.models?.find(item => item.id === model);
  if (config.models && (!configured || configured.discovered.unavailable)) executionError('runtime_resume_provider_unavailable');
  const modelConfig = configured ? {
    id: configured.id, contextWindowTokens: configured.override?.contextWindowTokens ?? configured.discovered.contextWindowTokens,
    maxOutputTokens: configured.override?.maxOutputTokens ?? configured.discovered.maxOutputTokens,
    defaultOutputTokens: configured.override?.defaultOutputTokens ?? configured.defaultOutputTokens,
    capabilities: configured.discovered.capabilities
  } : { id: model };
  return { providerId: config.id, model, configurationFingerprint: executionFingerprint({
    adapter: config.protocol, providerId: config.id, endpoint: endpoint.toString().replace(/\/$/u, ''), model: modelConfig
  }) };
}

/** Call at trusted producers with their known secret values, before persisting any text. */
export function assertPersistableInstructions(contents: readonly string[], knownSecrets: readonly string[] = []): void {
  for (const content of contents) {
    if (knownSecrets.some(secret => secret.length > 0 && content.includes(secret))
      || /(?:authorization\s*[:=]\s*bearer\s+\S+|(?:api[_-]?key|password|access[_-]?token)\s*[:=]\s*["']?[^\s"']{8,})/iu.test(content)) executionError(undefined, 'instructions');
  }
}

/** Bound the top-level meta JSON value before allocating its parsed object tree. */
export function validateOperationRecordSize(line: string): void {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let stringStart = 0;
  let metaStart = -1;
  let awaitingMeta = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') {
        quoted = false;
        if (depth === 1 && i - stringStart <= 25) {
          let next = i + 1;
          while (/\s/u.test(line[next] ?? '') && next < line.length) next++;
          if (line[next] === ':') {
            try { awaitingMeta = JSON.parse(line.slice(stringStart, i + 1)) === 'meta'; }
            catch { /* The ordinary record parser reports malformed JSON. */ }
          }
        }
      }
      continue;
    }
    if (char === '"') { quoted = true; stringStart = i; continue; }
    if (char === '{' || char === '[') {
      if (awaitingMeta && depth === 1) { metaStart = i; awaitingMeta = false; }
      depth++;
    } else if (char === '}' || char === ']') {
      depth--;
      if (metaStart >= 0 && depth === 1) {
        bytes(line.slice(metaStart, i + 1), MAX_OPERATION_META_BYTES, 'meta');
        metaStart = -1;
      }
    }
  }
}
