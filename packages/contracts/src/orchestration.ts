import { z } from 'zod';

export const UsageTotalsSchema = z.object({
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  cacheReadInputTokens: z.number().int().nonnegative().default(0),
  cacheWriteInputTokens: z.number().int().nonnegative().default(0)
});
export type UsageTotals = z.infer<typeof UsageTotalsSchema>;

export const SubAgentProfileSchema = z.string().trim().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/u);
export type SubAgentProfile = z.infer<typeof SubAgentProfileSchema>;

export const SubAgentStateSchema = z.enum(['queued', 'running', 'idle', 'completed', 'failed', 'cancelled', 'timed_out', 'closed']);
export type SubAgentState = z.infer<typeof SubAgentStateSchema>;

export const StructuredOutputErrorCodeSchema = z.enum([
  'output_schema_invalid',
  'output_schema_validation_failed'
]);
export type StructuredOutputErrorCode = z.infer<typeof StructuredOutputErrorCodeSchema>;

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
  errorCode: StructuredOutputErrorCodeSchema.optional(),
  error: z.string().optional(),
  incomplete: z.boolean().default(false),
  rounds: z.array(SubAgentRoundSchema).default([])
});
export type SubAgentSnapshot = z.infer<typeof SubAgentSnapshotSchema>;

export const WorkflowStepStateSchema = z.enum([
  'pending', 'queued', 'running', 'completed', 'failed', 'cancelled', 'timed_out', 'blocked', 'interrupted'
]);
export type WorkflowStepState = z.infer<typeof WorkflowStepStateSchema>;

export const WorkflowRunStateSchema = z.enum(['running', 'completed', 'failed', 'cancelled', 'timed_out', 'interrupted']);
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
  'workflow_deadlock'
]);
export type WorkflowStepErrorCode = z.infer<typeof WorkflowStepErrorCodeSchema>;

export const WorkflowErrorCodeSchema = z.enum([
  'workflow_timeout',
  'workflow_cancelled',
  'workflow_step_failed',
  'workflow_deadlock',
  'workflow_interrupted',
  'workflow_persistence_failed'
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
  'output_schema_validation_failed'
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

export const WorkflowStepInputSchema = z.object({
  valueFrom: z.string().regex(/^\$(?:workflow\.args\.[A-Za-z][A-Za-z0-9_-]{0,63}|steps\.[A-Za-z][A-Za-z0-9_-]{0,63}\.(?:output|structuredResult(?:\.[A-Za-z0-9_-]+)*))$/u)
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
  task: z.string().trim().min(1).max(40_000),
  outputSchema: z.record(z.string(), z.unknown()).optional()
});
export type WorkflowAgentStep = z.infer<typeof WorkflowAgentStepSchema>;

export const WorkflowDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(4_000).optional(),
  maxConcurrency: z.number().int().min(1).max(4).default(3),
  timeoutMs: z.number().int().min(5_000).max(1_800_000).default(600_000),
  steps: z.array(WorkflowAgentStepSchema).min(1).max(32),
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
    for (const input of Object.values(step.inputs ?? {})) {
      const match = /^\$steps\.([A-Za-z][A-Za-z0-9_-]{0,63})\./u.exec(input.valueFrom);
      if (!match) continue;
      const sourceStepId = match[1]!;
      if (!stepIds.has(sourceStepId)) {
        context.addIssue({ code: 'custom', path: ['steps', index, 'inputs'], message: `Unknown input source step: ${sourceStepId}` });
      } else if (!step.dependsOn.includes(sourceStepId)) {
        context.addIssue({ code: 'custom', path: ['steps', index, 'inputs'], message: `Input source ${sourceStepId} must be a direct dependency of ${step.id}.` });
      }
    }
  }
  if (definition.outputStepId && !stepIds.has(definition.outputStepId)) {
    context.addIssue({ code: 'custom', path: ['outputStepId'], message: `Unknown output step: ${definition.outputStepId}` });
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
  profile: SubAgentProfileSchema.optional(),
  model: z.string().min(1).optional(),
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
  usage: UsageTotalsSchema
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
