import { z } from 'zod';

export const MemoryKindSchema = z.enum([
  'preference', 'constraint', 'decision', 'fact', 'lesson', 'procedure', 'task', 'rule'
]);
export type MemoryKind = z.infer<typeof MemoryKindSchema>;

export const MemoryStatusSchema = z.enum(['proposed', 'confirmed']);
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;

export const ProjectIdentitySchema = z.object({
  id: z.string().regex(/^prj_[a-f0-9]{64}$/u),
  displayName: z.string().trim().min(1),
  canonicalPath: z.string().min(1)
});
export type ProjectIdentity = z.infer<typeof ProjectIdentitySchema>;

export type MemoryScopeKind = 'global' | 'project';
export type MemoryScopeRef = {
  globalScopeId: 'global';
  projectScopeId?: string;
};

export type MemoryScope = {
  id: string;
  kind: MemoryScopeKind;
  directory: string;
  displayName: string;
  projectIdentity?: ProjectIdentity;
};

export type MemoryDocument = {
  path: string;
  content: string;
  revision: string;
  updatedAt: number;
};

export type MemoryEntry = {
  id: string;
  scopeId: string;
  kind: MemoryKind;
  status: MemoryStatus;
  title?: string;
  content: string;
  tags: string[];
  sourceFile: string;
  sourceSessionId?: string;
  sourceOperationId?: string;
  confirmedBy?: 'user';
  createdAt: number;
  updatedAt: number;
  contentHash: string;
  ruleMode?: 'always' | 'triggered';
  triggers?: string[];
  unknownMetadata: Record<string, string>;
};

export type MemoryParseWarning = {
  sourceFile: string;
  line: number;
  message: string;
};

export type MemoryPatchRequest = {
  scope: MemoryScope;
  path: string;
  expectedRevision: string;
  patch:
    | { type: 'replace'; oldText: string; newText: string }
    | { type: 'append'; anchor?: string; content: string };
};

export type MemoryMutationResult = {
  previousRevision: string;
  revision: string;
  changed: boolean;
  scopeVersion: number;
  warning?: 'memory_index_stale';
};

export type MemorySearchResult = {
  entry: MemoryEntry;
  score: number;
  snippet: string;
};

export type MemoryScopeStatus = {
  id: string;
  kind: MemoryScopeKind;
  displayName: string;
  directory: string;
  version: number;
  contentHash: string;
  dirty: boolean;
  entryCount: number;
  warningCount: number;
  entries: MemoryEntry[];
};

export type MemoryStatusSnapshot = {
  root: string;
  ftsMode: 'trigram' | 'unicode61' | 'none';
  projectAvailable: boolean;
  scopes: MemoryScopeStatus[];
  pendingCandidates?: import('./memory-candidate.js').MemoryCandidate[];
};

export type MemorySnapshot = {
  id: string;
  version: number;
  scope: MemoryScopeRef;
  content: string;
  sourceEntryIds: string[];
  scopeVersions: Record<string, number>;
  estimatedTokens: number;
  contentHash: string;
};

export type MemoryRecall = {
  ruleIds: string[];
  content: string;
  estimatedTokens: number;
};

export type MemoryWarning = {
  code:
    | 'memory_handoff_failed'
    | 'memory_handoff_conflict'
    | 'memory_snapshot_binding_missing'
    | 'workflow_memory_snapshot_missing'
    | 'memory_scope_version_invalid';
  message: string;
};

export type MemoryHandoffItem = {
  text: string;
  source: 'scratchpad' | 'memory_tool' | 'compaction' | 'runtime';
  sourceEntryId?: string;
};

export type MemoryHandoff = {
  id: string;
  sessionId: string;
  operationId: string;
  openTasks: MemoryHandoffItem[];
  decisions: MemoryHandoffItem[];
  memoryWrites: MemoryHandoffItem[];
  createdAt: number;
  contentHash: string;
};

export type SubAgentMemoryBinding = {
  projectIdentity?: ProjectIdentity;
  parentSnapshotId: string;
  childSnapshotId: string;
  mode: 'project-minimal' | 'none';
};

export type WorkflowMemoryBinding = {
  projectIdentity?: ProjectIdentity;
  memorySnapshotId: string;
  contentHash: string;
  scopeVersions: Record<string, number>;
  createdAt: number;
};

export const MemorySettingsSchema = z.object({
  enabled: z.boolean().default(true),
  globalEnabled: z.boolean().default(true),
  projectEnabled: z.boolean().default(true),
  snapshotMode: z.literal('session-stable').default('session-stable'),
  maxSnapshotTokens: z.number().int().min(256).max(4096).default(4096),
  maxContextRatio: z.number().min(0.01).max(0.2).default(0.05),
  search: z.object({
    enabled: z.boolean().default(true),
    maxResults: z.number().int().min(1).max(50).default(10)
  }).default({ enabled: true, maxResults: 10 }),
  suggestions: z.preprocess((value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)
      && (value as { maxPerTurn?: unknown }).maxPerTurn === 0) {
      return { ...value, maxPerTurn: 3 };
    }
    return value;
  }, z.object({
    enabled: z.boolean().default(false),
    providerId: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1).optional(),
    maxPerTurn: z.number().int().min(1).max(3).default(3),
    evidenceMaxTokens: z.number().int().min(256).max(3_072).default(2_048),
    minEligibilityScore: z.number().int().min(0).max(200).default(30)
  })).default({ enabled: false, maxPerTurn: 3, evidenceMaxTokens: 2_048, minEligibilityScore: 30 }),
  autoRecall: z.boolean().default(true),
  recoveryRetentionDays: z.number().int().min(1).max(365).default(30),
  confirmDelete: z.boolean().default(true)
});
export type MemorySettings = z.infer<typeof MemorySettingsSchema>;
export const DEFAULT_MEMORY_SETTINGS: MemorySettings = MemorySettingsSchema.parse({});

export const MemoryWriteInputSchema = z.object({
  scope: z.enum(['global', 'project']),
  kind: MemoryKindSchema,
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(16 * 1024),
  tags: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
  target: z.enum(['index', 'topic', 'daily', 'scratchpad']).default('index'),
  ruleMode: z.enum(['always', 'triggered']).optional(),
  triggers: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  existingId: z.string().min(1).optional(),
  oldText: z.string().optional(),
  newText: z.string().optional(),
  expectedHash: z.string().regex(/^[a-f0-9]{64}$/u)
}).superRefine((value, context) => {
  if ((value.oldText === undefined) !== (value.newText === undefined)) {
    context.addIssue({ code: 'custom', message: 'oldText and newText must be supplied together.' });
  }
  if (value.kind !== 'rule' && (value.ruleMode !== undefined || value.triggers !== undefined)) {
    context.addIssue({ code: 'custom', message: 'ruleMode and triggers are only valid for rule entries.' });
  }
  if (value.ruleMode === 'triggered' && !value.triggers?.length) {
    context.addIssue({ code: 'custom', message: 'Triggered rules require at least one trigger.' });
  }
});
export type MemoryWriteInput = z.infer<typeof MemoryWriteInputSchema>;

export const MemoryReadInputSchema = z.object({
  scope: z.enum(['global', 'project']),
  path: z.string().default('MEMORY.md')
});

export const MemorySearchInputSchema = z.object({
  query: z.string().trim().min(1).max(500),
  scope: z.enum(['global', 'project', 'all']).default('all'),
  kinds: z.array(MemoryKindSchema).optional(),
  limit: z.number().int().min(1).max(50).default(10)
});

export const MemoryForgetInputSchema = z.object({
  scope: z.enum(['global', 'project']),
  id: z.string().min(1),
  expectedHash: z.string().regex(/^[a-f0-9]{64}$/u)
});

export const MemoryRestoreInputSchema = z.object({
  scope: z.enum(['global', 'project']),
  recoveryId: z.string().min(1),
  expectedHash: z.string().regex(/^[a-f0-9]{64}$/u).optional()
});

export class MemoryError extends Error {
  constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'MemoryError';
  }
}
