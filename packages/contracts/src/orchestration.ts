import { z } from 'zod';

export const UsageTotalsSchema = z.object({
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  cacheReadInputTokens: z.number().int().nonnegative().default(0),
  cacheWriteInputTokens: z.number().int().nonnegative().default(0)
});
export type UsageTotals = z.infer<typeof UsageTotalsSchema>;

export const SubAgentProfileSchema = z.enum(['explore', 'synthesize']);
export type SubAgentProfile = z.infer<typeof SubAgentProfileSchema>;

export const SubAgentStateSchema = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'timed_out']);
export type SubAgentState = z.infer<typeof SubAgentStateSchema>;

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
  error: z.string().optional(),
  incomplete: z.boolean().default(false)
});
export type SubAgentSnapshot = z.infer<typeof SubAgentSnapshotSchema>;

export const WorkflowStepStateSchema = z.enum([
  'pending', 'queued', 'running', 'completed', 'failed', 'cancelled', 'timed_out', 'blocked', 'interrupted'
]);
export type WorkflowStepState = z.infer<typeof WorkflowStepStateSchema>;

export const WorkflowRunStateSchema = z.enum(['running', 'completed', 'failed', 'cancelled', 'timed_out', 'interrupted']);
export type WorkflowRunState = z.infer<typeof WorkflowRunStateSchema>;

const WorkflowStepBaseSchema = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u),
  dependsOn: z.array(z.string()).max(16).default([]),
  timeoutMs: z.number().int().min(5_000).max(300_000).optional(),
  continueOnError: z.boolean().default(false)
});

export const WorkflowAgentStepSchema = WorkflowStepBaseSchema.extend({
  type: z.literal('agent'),
  profile: SubAgentProfileSchema.default('explore'),
  task: z.string().trim().min(1).max(40_000)
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
  state: WorkflowStepStateSchema,
  attempt: z.number().int().positive().default(1),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  output: z.string().optional(),
  error: z.string().optional(),
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
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  steps: z.array(WorkflowStepSnapshotSchema),
  usage: UsageTotalsSchema,
  result: z.string().optional(),
  error: z.string().optional(),
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
