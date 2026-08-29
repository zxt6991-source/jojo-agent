import { z } from 'zod';
import { ProjectIdentitySchema } from './memory.js';

export const UsageTotalsSchema = z.object({
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  cacheReadInputTokens: z.number().int().nonnegative().default(0),
  cacheWriteInputTokens: z.number().int().nonnegative().default(0)
});
export type UsageTotals = z.infer<typeof UsageTotalsSchema>;

export const SubAgentMemoryBindingSchema = z.object({
  projectIdentity: ProjectIdentitySchema.optional(),
  parentSnapshotId: z.string().min(1),
  childSnapshotId: z.string().min(1),
  mode: z.enum(['project-minimal', 'none'])
}).strict();

export const TeamMemberMemoryBindingSchema = z.object({
  projectIdentity: ProjectIdentitySchema.optional(),
  teamId: z.string().min(1).max(128),
  memberId: z.string().min(1).max(128),
  memorySnapshotId: z.string().min(1),
  mode: z.enum(['project-minimal', 'none'])
}).strict();
export type TeamMemberMemoryBinding = z.infer<typeof TeamMemberMemoryBindingSchema>;

export const WorkflowMemoryBindingSchema = z.object({
  projectIdentity: ProjectIdentitySchema.optional(),
  memorySnapshotId: z.string().min(1),
  contentHash: z.string().min(1),
  scopeVersions: z.record(z.string(), z.number().int().nonnegative()),
  createdAt: z.number().int().nonnegative()
}).strict();

export const SubAgentProfileSchema = z.string().trim().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/u);
export type SubAgentProfile = z.infer<typeof SubAgentProfileSchema>;

export const SubAgentStateSchema = z.enum(['queued', 'running', 'idle', 'completed', 'failed', 'cancelled', 'timed_out', 'closed']);
export type SubAgentState = z.infer<typeof SubAgentStateSchema>;

export const StructuredOutputErrorCodeSchema = z.enum([
  'output_schema_invalid',
  'output_schema_validation_failed'
]);
export type StructuredOutputErrorCode = z.infer<typeof StructuredOutputErrorCodeSchema>;

export const IsolationTypeSchema = z.enum(['none', 'worktree']);
export type IsolationType = z.infer<typeof IsolationTypeSchema>;

export const IsolationConfigSchema = z.object({
  type: IsolationTypeSchema
}).strict();
export type IsolationConfig = z.infer<typeof IsolationConfigSchema>;

export const IsolationErrorCodeSchema = z.enum([
  'isolation_required',
  'worktree_not_a_git_repository',
  'worktree_create_failed',
  'worktree_cleanup_failed',
  'worktree_path_invalid'
]);
export type IsolationErrorCode = z.infer<typeof IsolationErrorCodeSchema>;

export const ResourceGroupErrorCodeSchema = z.enum(['resource_group_conflict']);
export type ResourceGroupErrorCode = z.infer<typeof ResourceGroupErrorCodeSchema>;

export const WorkflowResourceGroupSchema = z.object({
  group: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
  maxConcurrency: z.number().int().min(1).max(4).default(1)
}).strict();
export type WorkflowResourceGroup = z.infer<typeof WorkflowResourceGroupSchema>;

const tokenBudgetFields = {
  maxInputTokens: z.number().int().min(1).max(10_000_000).optional(),
  maxOutputTokens: z.number().int().min(1).max(10_000_000).optional(),
  maxTotalTokens: z.number().int().min(1).max(20_000_000).optional()
};

type TokenBudgetFields = {
  maxInputTokens?: number | undefined;
  maxOutputTokens?: number | undefined;
  maxTotalTokens?: number | undefined;
};

function tokenBudgetHasLimit(budget: TokenBudgetFields): boolean {
  return budget.maxInputTokens !== undefined
    || budget.maxOutputTokens !== undefined
    || budget.maxTotalTokens !== undefined;
}

export const WorkflowStepBudgetSchema = z.object(tokenBudgetFields).strict().superRefine((budget, context) => {
  if (!tokenBudgetHasLimit(budget)) {
    context.addIssue({ code: 'custom', message: 'Budget must declare at least one token limit.' });
  }
});
export type WorkflowStepBudget = z.infer<typeof WorkflowStepBudgetSchema>;

export const WorkflowBudgetSchema = z.object({
  ...tokenBudgetFields,
  maxCostUsd: z.number().positive().max(10_000).optional(),
  inputUsdPerMillion: z.number().nonnegative().max(1_000).optional(),
  outputUsdPerMillion: z.number().nonnegative().max(1_000).optional()
}).strict().superRefine((budget, context) => {
  if (!tokenBudgetHasLimit(budget) && budget.maxCostUsd === undefined) {
    context.addIssue({ code: 'custom', message: 'Budget must declare at least one token or cost limit.' });
  }
  if (budget.maxCostUsd !== undefined && (budget.inputUsdPerMillion === undefined || budget.outputUsdPerMillion === undefined)) {
    context.addIssue({
      code: 'custom',
      message: 'maxCostUsd requires inputUsdPerMillion and outputUsdPerMillion.'
    });
  }
});
export type WorkflowBudget = z.infer<typeof WorkflowBudgetSchema>;

export const IsolationSnapshotSchema = z.object({
  type: z.literal('worktree'),
  workingDirectory: z.string().min(1).max(1024),
  worktreePath: z.string().min(1).max(1024),
  branch: z.string().min(1).max(255),
  commit: z.string().min(1).max(64).optional(),
  changedFiles: z.array(z.string().min(1).max(1024)).max(100).default([]),
  diffStat: z.string().max(16_000).optional(),
  diff: z.string().max(250_000).optional(),
  hasChanges: z.boolean(),
  cleanedUp: z.boolean().default(false),
  truncated: z.boolean().default(false)
}).strict();
export type IsolationSnapshot = z.infer<typeof IsolationSnapshotSchema>;

const TeamIdSchema = z.string().trim().min(1).max(128).regex(/^[a-z][a-z0-9_-]*$/u);
const TeamMemberIdSchema = z.string().trim().min(1).max(128).regex(/^[a-z][a-z0-9_-]*$/u);

export const TeamMemberStateSchema = z.enum([
  'idle', 'queued', 'running', 'waiting_approval', 'disabled', 'error'
]);
export type TeamMemberState = z.infer<typeof TeamMemberStateSchema>;

export const TeamTaskStateSchema = z.enum([
  'queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled', 'interrupted'
]);
export type TeamTaskState = z.infer<typeof TeamTaskStateSchema>;

export const TeamMessageKindSchema = z.enum(['task', 'note', 'question', 'result', 'system']);
export type TeamMessageKind = z.infer<typeof TeamMessageKindSchema>;

export const TeamMessageStatusSchema = z.enum(['unread', 'read']);
export type TeamMessageStatus = z.infer<typeof TeamMessageStatusSchema>;

export const TeamSpawnPolicySchema = z.object({
  enabled: z.boolean(),
  profiles: z.array(SubAgentProfileSchema).max(32).optional(),
  maxActive: z.number().int().min(1).max(8).optional()
}).strict();
export type TeamSpawnPolicy = z.infer<typeof TeamSpawnPolicySchema>;

export const TeamMemberDefinitionSchema = z.object({
  id: TeamMemberIdSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2_000).optional(),
  profile: SubAgentProfileSchema,
  providerId: z.string().trim().min(1).max(128).optional(),
  model: z.string().trim().min(1).max(256).optional(),
  systemPrompt: z.string().max(20_000).optional(),
  readOnly: z.boolean().optional(),
  tools: z.object({
    allow: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
    deny: z.array(z.string().trim().min(1).max(64)).max(32).optional()
  }).strict().optional(),
  spawn: TeamSpawnPolicySchema.optional()
}).strict();
export type TeamMemberDefinition = z.infer<typeof TeamMemberDefinitionSchema>;

export const TeamDefinitionSchema = z.object({
  id: TeamIdSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2_000).optional(),
  workspace: z.string().min(1).max(4_096),
  members: z.array(TeamMemberDefinitionSchema).min(1).max(32),
  maxConcurrency: z.number().int().min(1).max(16).default(3),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict().superRefine((team, context) => {
  const ids = new Set<string>();
  for (const member of team.members) {
    if (ids.has(member.id)) {
      context.addIssue({ code: 'custom', path: ['members'], message: `Duplicate team member id: ${member.id}` });
    }
    ids.add(member.id);
  }
});
export type TeamDefinition = z.infer<typeof TeamDefinitionSchema>;

export const TeamMemberSnapshotSchema = TeamMemberDefinitionSchema.extend({
  laneId: z.string().min(1).max(256),
  state: TeamMemberStateSchema,
  revision: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();
export type TeamMemberSnapshot = z.infer<typeof TeamMemberSnapshotSchema>;

export const TeamSnapshotSchema = z.object({
  id: TeamIdSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2_000).optional(),
  workspace: z.string().min(1).max(4_096),
  workspaceKey: z.string().min(1).max(256),
  runtimeSessionId: z.string().min(1).max(512),
  maxConcurrency: z.number().int().min(1).max(16),
  revision: z.number().int().nonnegative(),
  members: z.array(TeamMemberSnapshotSchema).max(32),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();
export type TeamSnapshot = z.infer<typeof TeamSnapshotSchema>;

export const TeamTaskSnapshotSchema = z.object({
  id: z.string().min(1).max(256),
  teamId: TeamIdSchema,
  memberId: TeamMemberIdSchema,
  parentSessionId: z.string().min(1).max(256).optional(),
  parentRunId: z.string().min(1).max(256).optional(),
  parentActorId: z.string().min(1).max(256).optional(),
  runtimeRunId: z.string().min(1).max(256).optional(),
  input: z.string().min(1).max(40_000),
  state: TeamTaskStateSchema,
  result: z.string().optional(),
  structuredResult: z.unknown().optional(),
  schemaValid: z.boolean().optional(),
  errorCode: z.string().min(1).max(256).optional(),
  error: z.string().max(100_000).optional(),
  stopReason: z.string().max(4_000).optional(),
  providerId: z.string().min(1).max(128),
  model: z.string().min(1).max(256),
  usage: UsageTotalsSchema,
  incomplete: z.boolean().default(false),
  isolation: IsolationSnapshotSchema.optional(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional()
}).strict();
export type TeamTaskSnapshot = z.infer<typeof TeamTaskSnapshotSchema>;

export const TeamMessageSchema = z.object({
  id: z.string().min(1).max(256),
  teamId: TeamIdSchema,
  senderKind: z.enum(['main', 'team_member', 'system']),
  senderId: z.string().min(1).max(256).optional(),
  recipientMemberId: TeamMemberIdSchema,
  kind: TeamMessageKindSchema,
  subject: z.string().max(500).optional(),
  content: z.string().min(1).max(40_000),
  taskId: z.string().min(1).max(256).optional(),
  status: TeamMessageStatusSchema,
  createdAt: z.string().datetime(),
  readAt: z.string().datetime().optional()
}).strict();
export type TeamMessage = z.infer<typeof TeamMessageSchema>;

export const TeamStatusSnapshotSchema = z.object({
  team: TeamSnapshotSchema,
  activeTasks: z.array(TeamTaskSnapshotSchema).max(100),
  queuedTasks: z.array(TeamTaskSnapshotSchema).max(100),
  recentTasks: z.array(TeamTaskSnapshotSchema).max(20),
  unreadMessages: z.number().int().nonnegative()
}).strict();
export type TeamStatusSnapshot = z.infer<typeof TeamStatusSnapshotSchema>;

export const TeamErrorCodeSchema = z.enum([
  'team_not_found', 'team_exists', 'team_member_not_found', 'team_member_disabled',
  'team_member_busy', 'team_task_not_found', 'team_task_cancelled', 'team_runtime_failed',
  'team_store_failed', 'team_message_not_found', 'team_concurrency_limit'
]);
export type TeamErrorCode = z.infer<typeof TeamErrorCodeSchema>;

export const SubAgentErrorCodeSchema = z.enum([
  ...StructuredOutputErrorCodeSchema.options,
  ...IsolationErrorCodeSchema.options,
  ...ResourceGroupErrorCodeSchema.options
]);
export type SubAgentErrorCode = z.infer<typeof SubAgentErrorCodeSchema>;

export const SubAgentRoundSchema = z.object({
  index: z.number().int().positive(),
  input: z.string().min(1).max(40_000),
  output: z.string().optional(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  usage: UsageTotalsSchema,
  stopReason: z.string().optional(),
  error: z.string().optional(),
  incomplete: z.boolean().default(false)
});
export type SubAgentRound = z.infer<typeof SubAgentRoundSchema>;

export const SubAgentSnapshotSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  label: z.string().min(1).max(120),
  task: z.string().min(1).max(40_000),
  profile: SubAgentProfileSchema,
  state: SubAgentStateSchema,
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  model: z.string().min(1),
  usage: UsageTotalsSchema,
  stopReason: z.string().optional(),
  result: z.string().optional(),
  structuredResult: z.unknown().optional(),
  schemaValid: z.boolean().optional(),
  errorCode: SubAgentErrorCodeSchema.optional(),
  error: z.string().optional(),
  incomplete: z.boolean().default(false),
  isolation: IsolationSnapshotSchema.optional(),
  resourceGroup: z.string().min(1).optional(),
  memory: SubAgentMemoryBindingSchema.optional(),
  parent: z.object({
    actor: z.enum(['main', 'team_member', 'workflow', 'subagent']),
    actorId: z.string().min(1).optional(),
    teamId: z.string().min(1).optional()
  }).strict().optional(),
  owner: z.object({
    kind: z.enum(['main', 'team_member', 'workflow']),
    id: z.string().min(1).optional(),
    teamId: z.string().min(1).optional()
  }).strict().optional(),
  depth: z.number().int().nonnegative().default(0),
  rounds: z.array(SubAgentRoundSchema).default([])
});
export type SubAgentSnapshot = z.infer<typeof SubAgentSnapshotSchema>;

export const WorkflowStepStateSchema = z.enum([
  'pending', 'queued', 'running', 'completed', 'failed', 'cancelled', 'timed_out', 'blocked', 'interrupted', 'skipped'
]);
export type WorkflowStepState = z.infer<typeof WorkflowStepStateSchema>;

export const WorkflowRunStateSchema = z.enum([
  'running', 'completed', 'failed', 'cancelled', 'timed_out', 'interrupted', 'suspended'
]);
export type WorkflowRunState = z.infer<typeof WorkflowRunStateSchema>;

export const WorkflowStepErrorCodeSchema = z.enum([
  'step_timeout',
  'workflow_timeout',
  'workflow_cancelled',
  'provider_timeout',
  'provider_error',
  'max_iterations',
  'invalid_profile',
  'output_schema_invalid',
  'output_schema_validation_failed',
  'workflow_reference_invalid',
  'workflow_reference_not_found',
  'workflow_step_failed',
  'workflow_deadlock',
  'isolation_required',
  'worktree_not_a_git_repository',
  'worktree_create_failed',
  'worktree_cleanup_failed',
  'worktree_path_invalid',
  'tool_not_allowed',
  'permission_denied',
  'workflow_step_type_unsupported',
  'foreach_items_invalid',
  'foreach_item_limit',
  'workflow_depth_exceeded',
  'saved_workflow_not_found',
  'workflow_invalid_args',
  'resource_group_conflict',
  'workflow_budget_exceeded',
  'browser_replay_failed',
  'browser_resume_unsafe'
]);
export type WorkflowStepErrorCode = z.infer<typeof WorkflowStepErrorCodeSchema>;

export const WorkflowErrorCodeSchema = z.enum([
  'workflow_timeout',
  'workflow_cancelled',
  'workflow_step_failed',
  'workflow_deadlock',
  'workflow_interrupted',
  'workflow_persistence_failed',
  'workflow_memory_snapshot_missing'
]);
export type WorkflowErrorCode = z.infer<typeof WorkflowErrorCodeSchema>;

const WorkflowStepBaseSchema = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u),
  dependsOn: z.array(z.string()).max(16).default([]),
  timeoutMs: z.number().int().min(5_000).max(300_000).optional(),
  continueOnError: z.boolean().default(false)
});

export const AgentToolPolicySchema = z.object({
  allow: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
  deny: z.array(z.string().trim().min(1).max(64)).max(32).optional()
}).strict();
export type AgentToolPolicy = z.infer<typeof AgentToolPolicySchema>;

export const WorkflowRetryableErrorCodeSchema = z.enum([
  'step_timeout',
  'provider_timeout',
  'provider_error',
  'output_schema_validation_failed',
  'browser_replay_failed'
]);
export type WorkflowRetryableErrorCode = z.infer<typeof WorkflowRetryableErrorCodeSchema>;

export const WorkflowRetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(5),
  backoffMs: z.number().int().min(0).max(30_000).default(1_000),
  retryOn: z.array(WorkflowRetryableErrorCodeSchema).min(1).max(4).default([
    'provider_timeout',
    'provider_error'
  ])
}).strict();
export type WorkflowRetryPolicy = z.infer<typeof WorkflowRetryPolicySchema>;

export const WorkflowArgumentValueSchema = z.union([
  z.string().max(40_000),
  z.number().finite(),
  z.boolean()
]);
export const WorkflowArgsSchema = z.record(
  z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u),
  WorkflowArgumentValueSchema
).superRefine((args, context) => {
  if (Object.keys(args).length > 32) context.addIssue({ code: 'custom', message: 'Workflow args may contain at most 32 entries.' });
});
export type WorkflowArgs = z.infer<typeof WorkflowArgsSchema>;

export const WorkflowInputTypeSchema = z.enum(['string', 'number', 'boolean']);
export type WorkflowInputType = z.infer<typeof WorkflowInputTypeSchema>;

export const WorkflowInputDefinitionSchema = z.object({
  type: WorkflowInputTypeSchema,
  required: z.boolean().default(false),
  default: WorkflowArgumentValueSchema.optional(),
  description: z.string().max(500).optional()
}).strict().superRefine((input, context) => {
  if (input.default === undefined) return;
  const actual = typeof input.default;
  if (actual !== input.type) {
    context.addIssue({ code: 'custom', message: `Workflow input default must be a ${input.type}.` });
  }
});
export type WorkflowInputDefinition = z.infer<typeof WorkflowInputDefinitionSchema>;

export const WorkflowInputDefinitionsSchema = z.record(
  z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u),
  WorkflowInputDefinitionSchema
).superRefine((inputs, context) => {
  if (Object.keys(inputs).length > 32) context.addIssue({ code: 'custom', message: 'Workflow input definitions may contain at most 32 entries.' });
});
export type WorkflowInputDefinitions = z.infer<typeof WorkflowInputDefinitionsSchema>;

export const WorkflowStepInputSchema = z.object({
  valueFrom: z.string().regex(/^\$(?:workflow\.args\.[A-Za-z][A-Za-z0-9_-]{0,63}|steps\.[A-Za-z][A-Za-z0-9_-]{0,63}\.(?:output|outputs(?:\.[A-Za-z0-9_-]+)+|structuredResult(?:\.[A-Za-z0-9_-]+)*))$/u)
}).strict();
export type WorkflowStepInput = z.infer<typeof WorkflowStepInputSchema>;

export const WorkflowStepInputsSchema = z.record(
  z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u),
  WorkflowStepInputSchema
).superRefine((inputs, context) => {
  if (Object.keys(inputs).length > 32) context.addIssue({ code: 'custom', message: 'Workflow step inputs may contain at most 32 entries.' });
});
export type WorkflowStepInputs = z.infer<typeof WorkflowStepInputsSchema>;

export const WorkflowAgentStepSchema = WorkflowStepBaseSchema.extend({
  type: z.literal('agent'),
  profile: SubAgentProfileSchema.default('explore'),
  model: z.string().trim().min(1).max(200).optional(),
  maxIterations: z.number().int().min(1).max(20).optional(),
  tools: AgentToolPolicySchema.optional(),
  readOnly: z.boolean().optional(),
  inputs: WorkflowStepInputsSchema.optional(),
  retry: WorkflowRetryPolicySchema.optional(),
  isolation: IsolationConfigSchema.optional(),
  resources: WorkflowResourceGroupSchema.optional(),
  budget: WorkflowStepBudgetSchema.optional(),
  task: z.string().trim().min(1).max(40_000),
  outputSchema: z.record(z.string(), z.unknown()).optional()
});
export type WorkflowAgentStep = z.infer<typeof WorkflowAgentStepSchema>;

export const WorkflowToolStepNameSchema = z.enum([
  'read_file',
  'list_files',
  'grep',
  'glob',
  'web_search',
  'web_fetch'
]);
export type WorkflowToolStepName = z.infer<typeof WorkflowToolStepNameSchema>;

const MAX_WORKFLOW_TOOL_INPUT_BYTES = 16 * 1024;

export const WorkflowToolStepInputSchema = z.record(
  z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u),
  z.unknown()
).superRefine((input, context) => {
  if (Object.keys(input).length > 32) {
    context.addIssue({ code: 'custom', message: 'Workflow tool input may contain at most 32 entries.' });
    return;
  }
  let serialized: string;
  try { serialized = JSON.stringify(input); }
  catch {
    context.addIssue({ code: 'custom', message: 'Workflow tool input must be JSON-serializable.' });
    return;
  }
  if (serialized === undefined || Buffer.byteLength(serialized) > MAX_WORKFLOW_TOOL_INPUT_BYTES) {
    context.addIssue({ code: 'custom', message: `Workflow tool input may not exceed ${MAX_WORKFLOW_TOOL_INPUT_BYTES} bytes.` });
  }
});
export type WorkflowToolStepInput = z.infer<typeof WorkflowToolStepInputSchema>;

export const WorkflowToolStepSchema = WorkflowStepBaseSchema.extend({
  type: z.literal('tool'),
  tool: WorkflowToolStepNameSchema,
  input: WorkflowToolStepInputSchema.default({}),
  inputs: WorkflowStepInputsSchema.optional(),
  retry: WorkflowRetryPolicySchema.optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional()
});
export type WorkflowToolStep = z.infer<typeof WorkflowToolStepSchema>;

export const WorkflowRecordingStepSchema = WorkflowStepBaseSchema.extend({
  type: z.literal('recording'),
  recording: z.string().regex(/^(?:r[1-9][0-9]*|[a-z0-9][a-z0-9-]{0,79})$/u),
  params: z.record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u),
    z.union([z.string().max(4_000), z.number().finite(), z.boolean()])
  ).default({}),
  inputs: WorkflowStepInputsSchema.optional(),
  retry: WorkflowRetryPolicySchema.optional(),
  maxRetries: z.number().int().min(0).max(3).default(2),
  retryDelayMs: z.number().int().min(100).max(2_000).default(250),
  outputSchema: z.record(z.string(), z.unknown()).optional()
});
export type WorkflowRecordingStep = z.infer<typeof WorkflowRecordingStepSchema>;

export const WorkflowForeachAgentTemplateSchema = WorkflowAgentStepSchema.omit({
  id: true,
  dependsOn: true,
  continueOnError: true
});
export type WorkflowForeachAgentTemplate = z.infer<typeof WorkflowForeachAgentTemplateSchema>;

export const WorkflowForeachToolTemplateSchema = WorkflowToolStepSchema.omit({
  id: true,
  dependsOn: true,
  continueOnError: true
});
export type WorkflowForeachToolTemplate = z.infer<typeof WorkflowForeachToolTemplateSchema>;

export const WorkflowForeachTemplateSchema = z.discriminatedUnion('type', [
  WorkflowForeachAgentTemplateSchema,
  WorkflowForeachToolTemplateSchema
]);
export type WorkflowForeachTemplate = z.infer<typeof WorkflowForeachTemplateSchema>;

export const WorkflowForeachStepSchema = WorkflowStepBaseSchema.extend({
  type: z.literal('foreach'),
  items: WorkflowStepInputSchema,
  itemLimit: z.number().int().min(1).max(20).default(8),
  concurrency: z.number().int().min(1).max(4).default(2),
  template: WorkflowForeachTemplateSchema
});
export type WorkflowForeachStep = z.infer<typeof WorkflowForeachStepSchema>;

export const WorkflowConditionOpSchema = z.enum(['equals', 'notEquals', 'exists']);
export type WorkflowConditionOp = z.infer<typeof WorkflowConditionOpSchema>;

export const WorkflowConditionWhenSchema = z.object({
  op: WorkflowConditionOpSchema,
  left: WorkflowStepInputSchema,
  right: z.union([z.string().max(4_000), z.number().finite(), z.boolean()]).optional()
}).strict().superRefine((when, context) => {
  if (when.op === 'exists' && when.right !== undefined) {
    context.addIssue({ code: 'custom', path: ['right'], message: 'exists does not take a right operand.' });
  }
  if (when.op !== 'exists' && when.right === undefined) {
    context.addIssue({ code: 'custom', path: ['right'], message: 'equals/notEquals require a right operand.' });
  }
});
export type WorkflowConditionWhen = z.infer<typeof WorkflowConditionWhenSchema>;

export const WorkflowConditionStepSchema = WorkflowStepBaseSchema.extend({
  type: z.literal('condition'),
  when: WorkflowConditionWhenSchema,
  then: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u)).max(16).default([]),
  else: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u)).max(16).default([])
});
export type WorkflowConditionStep = z.infer<typeof WorkflowConditionStepSchema>;

export const WorkflowNestedArgSchema = z.union([
  z.string().max(40_000),
  z.number().finite(),
  z.boolean(),
  WorkflowStepInputSchema
]);
export type WorkflowNestedArg = z.infer<typeof WorkflowNestedArgSchema>;

export const WorkflowCallStepSchema = WorkflowStepBaseSchema.extend({
  type: z.literal('workflow'),
  name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
  args: z.record(
    z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u),
    WorkflowNestedArgSchema
  ).superRefine((args, context) => {
    if (Object.keys(args).length > 32) {
      context.addIssue({ code: 'custom', message: 'Nested workflow args may contain at most 32 entries.' });
    }
  }).optional()
});
export type WorkflowCallStep = z.infer<typeof WorkflowCallStepSchema>;

export const WorkflowStepSchema = z.discriminatedUnion('type', [
  WorkflowAgentStepSchema,
  WorkflowToolStepSchema,
  WorkflowRecordingStepSchema,
  WorkflowForeachStepSchema,
  WorkflowConditionStepSchema,
  WorkflowCallStepSchema
]);
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

export const WorkflowDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(4_000).optional(),
  inputs: WorkflowInputDefinitionsSchema.optional(),
  maxConcurrency: z.number().int().min(1).max(4).default(3),
  timeoutMs: z.number().int().min(5_000).max(1_800_000).default(600_000),
  budget: WorkflowBudgetSchema.optional(),
  steps: z.array(WorkflowStepSchema).min(1).max(32),
  outputStepId: z.string().optional()
}).superRefine((definition, context) => {
  const stepIds = new Set<string>();
  for (const [index, step] of definition.steps.entries()) {
    if (stepIds.has(step.id)) {
      context.addIssue({ code: 'custom', path: ['steps', index, 'id'], message: `Duplicate step id: ${step.id}` });
    }
    stepIds.add(step.id);
  }
  for (const [index, step] of definition.steps.entries()) {
    for (const dependency of step.dependsOn) {
      if (dependency === step.id) {
        context.addIssue({ code: 'custom', path: ['steps', index, 'dependsOn'], message: `Step ${step.id} cannot depend on itself.` });
      } else if (!stepIds.has(dependency)) {
        context.addIssue({ code: 'custom', path: ['steps', index, 'dependsOn'], message: `Unknown dependency: ${dependency}` });
      }
    }
    const declaredInputs = step.type === 'agent' || step.type === 'tool' || step.type === 'recording'
      ? step.inputs
      : step.type === 'foreach'
        ? step.template.inputs
        : undefined;
    for (const input of Object.values(declaredInputs ?? {})) {
      const match = /^\$steps\.([A-Za-z][A-Za-z0-9_-]{0,63})\./u.exec(input.valueFrom);
      if (!match) continue;
      const sourceStepId = match[1]!;
      const inputPath = step.type === 'foreach' ? ['steps', index, 'template', 'inputs'] : ['steps', index, 'inputs'];
      if (!stepIds.has(sourceStepId)) {
        context.addIssue({ code: 'custom', path: inputPath, message: `Unknown input source step: ${sourceStepId}` });
      } else if (!step.dependsOn.includes(sourceStepId)) {
        context.addIssue({ code: 'custom', path: inputPath, message: `Input source ${sourceStepId} must be a direct dependency of ${step.id}.` });
      }
    }
    if (step.type === 'foreach') {
      const match = /^\$steps\.([A-Za-z][A-Za-z0-9_-]{0,63})\./u.exec(step.items.valueFrom);
      if (!match) {
        context.addIssue({
          code: 'custom',
          path: ['steps', index, 'items'],
          message: 'Foreach items must reference a direct dependency step.'
        });
      } else {
        const sourceStepId = match[1]!;
        if (!stepIds.has(sourceStepId)) {
          context.addIssue({ code: 'custom', path: ['steps', index, 'items'], message: `Unknown foreach source step: ${sourceStepId}` });
        } else if (!step.dependsOn.includes(sourceStepId)) {
          context.addIssue({ code: 'custom', path: ['steps', index, 'items'], message: `Foreach source ${sourceStepId} must be a direct dependency of ${step.id}.` });
        }
      }
    }
    if (step.type === 'condition') {
      const match = /^\$steps\.([A-Za-z][A-Za-z0-9_-]{0,63})\./u.exec(step.when.left.valueFrom);
      if (match) {
        const sourceStepId = match[1]!;
        if (!stepIds.has(sourceStepId)) {
          context.addIssue({ code: 'custom', path: ['steps', index, 'when', 'left'], message: `Unknown condition source step: ${sourceStepId}` });
        } else if (!step.dependsOn.includes(sourceStepId)) {
          context.addIssue({ code: 'custom', path: ['steps', index, 'when', 'left'], message: `Condition source ${sourceStepId} must be a direct dependency of ${step.id}.` });
        }
      }
      const branchIds = [...step.then, ...step.else];
      const seen = new Set<string>();
      for (const branchId of branchIds) {
        if (seen.has(branchId)) {
          context.addIssue({ code: 'custom', path: ['steps', index], message: `Condition branch ${branchId} cannot appear in both then and else.` });
        }
        seen.add(branchId);
        if (branchId === step.id) {
          context.addIssue({ code: 'custom', path: ['steps', index], message: `Condition ${step.id} cannot branch to itself.` });
        } else if (!stepIds.has(branchId)) {
          context.addIssue({ code: 'custom', path: ['steps', index], message: `Unknown condition branch: ${branchId}` });
        } else {
          const branch = definition.steps.find((item) => item.id === branchId);
          if (branch && !branch.dependsOn.includes(step.id)) {
            context.addIssue({
              code: 'custom',
              path: ['steps', index],
              message: `Condition branch ${branchId} must depend on ${step.id}.`
            });
          }
        }
      }
    }
    if (step.type === 'workflow') {
      for (const [name, value] of Object.entries(step.args ?? {})) {
        if (!value || typeof value !== 'object' || !('valueFrom' in value)) continue;
        const match = /^\$steps\.([A-Za-z][A-Za-z0-9_-]{0,63})\./u.exec(value.valueFrom);
        if (!match) continue;
        const sourceStepId = match[1]!;
        if (!stepIds.has(sourceStepId)) {
          context.addIssue({ code: 'custom', path: ['steps', index, 'args', name], message: `Unknown nested workflow arg source step: ${sourceStepId}` });
        } else if (!step.dependsOn.includes(sourceStepId)) {
          context.addIssue({ code: 'custom', path: ['steps', index, 'args', name], message: `Nested workflow arg source ${sourceStepId} must be a direct dependency of ${step.id}.` });
        }
      }
    }
  }

  const resourceGroups = new Map<string, number>();
  for (const [index, step] of definition.steps.entries()) {
    const resources = step.type === 'agent'
      ? step.resources
      : step.type === 'foreach' && step.template.type === 'agent'
        ? step.template.resources
        : undefined;
    if (!resources) continue;
    const previous = resourceGroups.get(resources.group);
    if (previous !== undefined && previous !== resources.maxConcurrency) {
      context.addIssue({
        code: 'custom',
        path: step.type === 'foreach' ? ['steps', index, 'template', 'resources'] : ['steps', index, 'resources'],
        message: `Resource group ${resources.group} maxConcurrency must be ${previous}.`
      });
    }
    resourceGroups.set(resources.group, resources.maxConcurrency);
  }
  if (definition.outputStepId && !stepIds.has(definition.outputStepId)) {
    context.addIssue({ code: 'custom', path: ['outputStepId'], message: `Unknown output step: ${definition.outputStepId}` });
  }

  const declaredInputs = definition.inputs;
  if (declaredInputs) {
    const placeholder = /\{\{inputs\.([A-Za-z][A-Za-z0-9_-]{0,63})\}\}/gu;
    for (const [index, step] of definition.steps.entries()) {
      const task = step.type === 'agent'
        ? step.task
        : step.type === 'foreach' && step.template.type === 'agent'
          ? step.template.task
          : undefined;
      if (!task) continue;
      placeholder.lastIndex = 0;
      for (const match of task.matchAll(placeholder)) {
        const name = match[1]!;
        if (!Object.prototype.hasOwnProperty.call(declaredInputs, name)) {
          context.addIssue({
            code: 'custom',
            path: step.type === 'foreach' ? ['steps', index, 'template', 'task'] : ['steps', index, 'task'],
            message: `Unknown workflow input placeholder: ${name}`
          });
        }
      }
    }
  }

  const dependencies = new Map(definition.steps.map((step) => [step.id, step.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (stepId: string): boolean => {
    if (visiting.has(stepId)) return true;
    if (visited.has(stepId)) return false;
    visiting.add(stepId);
    for (const dependency of dependencies.get(stepId) ?? []) {
      if (dependencies.has(dependency) && visit(dependency)) return true;
    }
    visiting.delete(stepId);
    visited.add(stepId);
    return false;
  };
  if (definition.steps.some((step) => visit(step.id))) {
    context.addIssue({ code: 'custom', path: ['steps'], message: 'Workflow dependency graph contains a cycle.' });
  }
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

export const WorkflowStepSnapshotSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['agent', 'tool', 'recording', 'foreach', 'condition', 'workflow']).optional(),
  profile: SubAgentProfileSchema.optional(),
  tool: WorkflowToolStepNameSchema.optional(),
  recording: z.string().min(1).optional(),
  workflow: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  parentId: z.string().min(1).optional(),
  index: z.number().int().nonnegative().optional(),
  item: z.unknown().optional(),
  state: WorkflowStepStateSchema,
  attempt: z.number().int().positive().default(1),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  output: z.string().optional(),
  structuredResult: z.unknown().optional(),
  schemaValid: z.boolean().optional(),
  error: z.string().optional(),
  errorCode: WorkflowStepErrorCodeSchema.optional(),
  stopReason: z.string().optional(),
  incomplete: z.boolean().default(false),
  usage: UsageTotalsSchema,
  isolation: IsolationSnapshotSchema.optional(),
  resourceGroup: z.string().min(1).optional(),
  memorySnapshotId: z.string().min(1).optional(),
  dependsOn: z.array(z.string().min(1)).max(16).optional(),
  instances: z.array(z.object({
    id: z.string().min(1),
    type: z.enum(['agent', 'tool']).optional(),
    profile: SubAgentProfileSchema.optional(),
    tool: WorkflowToolStepNameSchema.optional(),
    model: z.string().min(1).optional(),
    resourceGroup: z.string().min(1).optional(),
    parentId: z.string().min(1).optional(),
    index: z.number().int().nonnegative().optional(),
    item: z.unknown().optional(),
    state: WorkflowStepStateSchema,
    attempt: z.number().int().positive().default(1),
    createdAt: z.string().datetime(),
    startedAt: z.string().datetime().optional(),
    finishedAt: z.string().datetime().optional(),
    output: z.string().optional(),
    structuredResult: z.unknown().optional(),
    schemaValid: z.boolean().optional(),
    error: z.string().optional(),
    errorCode: WorkflowStepErrorCodeSchema.optional(),
    stopReason: z.string().optional(),
    incomplete: z.boolean().default(false),
    usage: UsageTotalsSchema,
    isolation: IsolationSnapshotSchema.optional()
  })).max(20).optional(),
  child: z.unknown().optional()
});
export type WorkflowStepSnapshot = z.infer<typeof WorkflowStepSnapshotSchema>;

export const WorkflowRunSnapshotSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  name: z.string().min(1),
  state: WorkflowRunStateSchema,
  revision: z.number().int().nonnegative().default(0),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  steps: z.array(WorkflowStepSnapshotSchema),
  usage: UsageTotalsSchema,
  budget: WorkflowBudgetSchema.optional(),
  memory: WorkflowMemoryBindingSchema.optional(),
  result: z.string().optional(),
  error: z.string().optional(),
  errorCode: WorkflowErrorCodeSchema.optional(),
  failedStepIds: z.array(z.string()).default([]),
  blockedStepIds: z.array(z.string()).default([]),
  incomplete: z.boolean().default(false)
});
export type WorkflowRunSnapshot = z.infer<typeof WorkflowRunSnapshotSchema>;

export const OrchestrationEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subagent.changed'), subagent: SubAgentSnapshotSchema }),
  z.object({ type: z.literal('workflow.changed'), workflow: WorkflowRunSnapshotSchema }),
  z.object({ type: z.literal('team.changed'), team: TeamSnapshotSchema }),
  z.object({ type: z.literal('team.deleted'), teamId: TeamIdSchema }),
  z.object({ type: z.literal('team.member.changed'), teamId: TeamIdSchema, member: TeamMemberSnapshotSchema }),
  z.object({ type: z.literal('team.task.changed'), task: TeamTaskSnapshotSchema }),
  z.object({ type: z.literal('team.message.created'), message: TeamMessageSchema }),
  z.object({
    type: z.literal('workflow.log'),
    runId: z.string().min(1),
    stepId: z.string().optional(),
    level: z.enum(['info', 'warning', 'error']),
    message: z.string(),
    createdAt: z.string().datetime()
  })
]);
export type OrchestrationEvent = z.infer<typeof OrchestrationEventSchema>;

export const StoredWorkflowRequestSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  workingDirectory: z.string().min(1),
  providerId: z.string().min(1),
  model: z.string().min(1),
  args: WorkflowArgsSchema.default({}),
  definition: WorkflowDefinitionSchema,
  definitionHash: z.string().regex(/^[a-f0-9]{64}$/u),
  memory: WorkflowMemoryBindingSchema.optional(),
  browserApproved: z.boolean().optional(),
  createdAt: z.string().datetime()
});
export type StoredWorkflowRequest = z.infer<typeof StoredWorkflowRequestSchema>;

export const WorkflowJournalRecordTypeSchema = z.enum([
  'workflow.started',
  'workflow.updated',
  'workflow.completed',
  'workflow.failed',
  'workflow.cancelled',
  'workflow.timed_out',
  'workflow.interrupted',
  'step.started',
  'step.retrying',
  'step.completed',
  'step.failed',
  'step.cancelled',
  'step.timed_out',
  'step.blocked',
  'workflow.log'
]);
export type WorkflowJournalRecordType = z.infer<typeof WorkflowJournalRecordTypeSchema>;

export const WorkflowJournalRecordSchema = z.object({
  schemaVersion: z.literal(1),
  type: WorkflowJournalRecordTypeSchema,
  runId: z.string().min(1),
  createdAt: z.string().datetime(),
  request: StoredWorkflowRequestSchema.optional(),
  snapshot: WorkflowRunSnapshotSchema.optional(),
  stepId: z.string().optional(),
  level: z.enum(['info', 'warning', 'error']).optional(),
  message: z.string().optional()
}).superRefine((record, context) => {
  if (record.type === 'workflow.started' && (!record.request || !record.snapshot)) {
    context.addIssue({ code: 'custom', message: 'workflow.started requires request and snapshot.' });
  }
  if (record.type.startsWith('step.') && !record.stepId) {
    context.addIssue({ code: 'custom', message: `${record.type} requires stepId.` });
  }
  if (record.type === 'workflow.log' && (!record.level || !record.message)) {
    context.addIssue({ code: 'custom', message: 'workflow.log requires level and message.' });
  }
});
export type WorkflowJournalRecord = z.infer<typeof WorkflowJournalRecordSchema>;
