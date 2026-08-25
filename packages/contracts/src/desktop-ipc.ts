import { z } from 'zod';
import { AgentEventSchema, BoundedJsonValueSchema, serializedIpcBytes } from './agent.js';
import { BrowserActionSchema, StartTurnInputSchema } from './desktop.js';
import { BrowserHealProposalSchema, BrowserHealRequestSchema } from './browser-recording.js';
import { ExtensionStatusSchema } from './extensions.js';
import { ToolResultSchema } from './messages.js';
import { MemoryKindSchema, MemoryStatusSchema } from './memory.js';
import { MemoryCandidateReviewEditSchema, MemoryCandidateSchema } from './memory-candidate.js';
import { SemanticIndexStatusSchema } from './memory-semantic.js';
import { OrchestrationEventSchema } from './orchestration.js';
import { ProviderSettingsSchema } from './persistence.js';

export const MAX_WORKER_COMMAND_BYTES = 16 * 1024 * 1024;
export const MAX_WORKER_MESSAGE_BYTES = 16 * 1024 * 1024;
export const MAX_ORCHESTRATION_EVENT_BYTES = 4 * 1024 * 1024;

const IdSchema = z.string().min(1).max(256);
const WorkingDirectorySchema = z.string().min(1).max(4_096);
const ErrorSchema = z.string().max(100_000);

const MemoryEntryIpcSchema = z.object({
  id: z.string().min(1).max(512), scopeId: z.string().min(1).max(512), kind: MemoryKindSchema,
  status: MemoryStatusSchema, title: z.string().max(512).optional(), content: z.string().max(200_000),
  tags: z.array(z.string().max(64)).max(100), sourceFile: z.string().max(4_096),
  sourceSessionId: z.string().max(512).optional(), sourceOperationId: z.string().max(512).optional(),
  confirmedBy: z.literal('user').optional(), createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
  contentHash: z.string().min(1).max(256), ruleMode: z.enum(['always', 'triggered']).optional(),
  triggers: z.array(z.string().max(100)).max(100).optional(),
  unknownMetadata: z.record(z.string(), z.string().max(20_000))
}).strict();

const MemoryScopeStatusIpcSchema = z.object({
  id: z.string().min(1).max(512), kind: z.enum(['global', 'project']), displayName: z.string().max(512),
  directory: WorkingDirectorySchema, version: z.number().int().nonnegative(), contentHash: z.string().max(256),
  dirty: z.boolean(), entryCount: z.number().int().nonnegative(), warningCount: z.number().int().nonnegative(),
  entries: z.array(MemoryEntryIpcSchema).max(10_000)
}).strict();

export const MemoryStatusSnapshotIpcSchema = z.object({
  root: WorkingDirectorySchema, ftsMode: z.enum(['trigram', 'unicode61', 'none']), projectAvailable: z.boolean(),
  scopes: z.array(MemoryScopeStatusIpcSchema).max(1_000),
  pendingCandidates: z.array(MemoryCandidateSchema).max(10_000).optional(),
  semantic: SemanticIndexStatusSchema.optional()
}).strict();

const WorkerCommandBaseSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('turn.start'), payload: StartTurnInputSchema }).strict(),
  z.object({ type: z.literal('turn.cancel'), sessionId: IdSchema }).strict(),
  z.object({ type: z.literal('session.stop'), requestId: IdSchema, sessionId: IdSchema }).strict(),
  z.object({ type: z.literal('workflow.cancel'), sessionId: IdSchema, workflowId: IdSchema }).strict(),
  z.object({ type: z.literal('workflow.resume'), requestId: IdSchema, sessionId: IdSchema, workflowId: IdSchema }).strict(),
  z.object({ type: z.literal('approval.resolve'), requestId: IdSchema, allow: z.boolean() }).strict(),
  z.object({
    type: z.literal('config.update'), settings: ProviderSettingsSchema,
    apiKeys: z.record(z.string().min(1).max(256), z.string().max(100_000)),
    mcpOAuthCredentials: z.record(z.string().min(1).max(256), BoundedJsonValueSchema)
  }).strict(),
  z.object({ type: z.literal('mcp.oauth.start'), requestId: IdSchema, serverId: IdSchema, redirectUrl: z.string().url().max(4_096), state: IdSchema }).strict(),
  z.object({ type: z.literal('mcp.oauth.callback'), requestId: IdSchema, serverId: IdSchema, callbackParams: z.string().max(100_000) }).strict(),
  z.object({ type: z.literal('mcp.oauth.disconnect'), requestId: IdSchema, serverId: IdSchema }).strict(),
  z.object({ type: z.literal('mcp.reconnect'), requestId: IdSchema, serverId: IdSchema }).strict(),
  z.object({ type: z.literal('browser.heal.request'), requestId: IdSchema, sessionId: IdSchema, request: BrowserHealRequestSchema }).strict(),
  z.object({ type: z.literal('browser.progress'), requestId: IdSchema, text: z.string().min(1).max(20_000) }).strict(),
  z.object({ type: z.literal('browser.result'), requestId: IdSchema, result: ToolResultSchema.optional(), error: ErrorSchema.optional() }).strict(),
  z.object({ type: z.literal('hooks.invalidate'), requestId: IdSchema }).strict(),
  z.object({ type: z.literal('memory.status'), requestId: IdSchema, workingDirectory: WorkingDirectorySchema.optional() }).strict(),
  z.object({ type: z.literal('memory.rebuild'), requestId: IdSchema, scope: z.enum(['global', 'project']), workingDirectory: WorkingDirectorySchema.optional() }).strict(),
  z.object({ type: z.literal('memory.semantic.rebuild'), requestId: IdSchema, workingDirectory: WorkingDirectorySchema.optional() }).strict(),
  z.object({ type: z.literal('memory.delete'), requestId: IdSchema, scope: z.enum(['global', 'project']), entryId: z.string().min(1).max(512), workingDirectory: WorkingDirectorySchema.optional() }).strict(),
  z.object({
    type: z.literal('memory.candidate.accept'), requestId: IdSchema, candidateId: z.string().min(1).max(512),
    workingDirectory: WorkingDirectorySchema.optional(), userConfirmed: z.literal(true), edit: MemoryCandidateReviewEditSchema.optional()
  }).strict(),
  z.object({ type: z.literal('memory.candidate.reject'), requestId: IdSchema, candidateId: z.string().min(1).max(512), workingDirectory: WorkingDirectorySchema.optional() }).strict()
]);

export const WorkerCommandSchema = WorkerCommandBaseSchema.superRefine((value, context) => {
  if (serializedIpcBytes(value) > MAX_WORKER_COMMAND_BYTES) {
    context.addIssue({ code: 'custom', message: 'Worker command exceeds the IPC size limit.' });
  }
});
export type WorkerCommand = z.infer<typeof WorkerCommandSchema>;

const SizedOrchestrationEventSchema = OrchestrationEventSchema.superRefine((value, context) => {
  if (serializedIpcBytes(value) > MAX_ORCHESTRATION_EVENT_BYTES) {
    context.addIssue({ code: 'custom', message: 'Orchestration event exceeds the IPC size limit.' });
  }
});

const WorkerMessageBaseSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }).strict(),
  z.object({ type: z.literal('agent.event'), event: AgentEventSchema }).strict(),
  z.object({ type: z.literal('orchestration.event'), event: SizedOrchestrationEventSchema }).strict(),
  z.object({ type: z.literal('session.stopped'), requestId: IdSchema, sessionId: IdSchema, ok: z.boolean(), error: ErrorSchema.optional() }).strict(),
  z.object({ type: z.literal('workflow.action.result'), requestId: IdSchema, ok: z.boolean(), error: ErrorSchema.optional() }).strict(),
  z.object({ type: z.literal('sessions.changed') }).strict(),
  z.object({ type: z.literal('extensions.status'), status: ExtensionStatusSchema }).strict(),
  z.object({ type: z.literal('mcp.oauth.authorization'), requestId: IdSchema, url: z.string().url().max(4_096) }).strict(),
  z.object({ type: z.literal('mcp.oauth.credentials'), serverId: IdSchema, credentials: BoundedJsonValueSchema }).strict(),
  z.object({ type: z.literal('mcp.oauth.result'), requestId: IdSchema, ok: z.boolean(), error: ErrorSchema.optional() }).strict(),
  z.object({ type: z.literal('browser.request'), requestId: IdSchema, sessionId: IdSchema, action: BrowserActionSchema, approved: z.boolean() }).strict(),
  z.object({ type: z.literal('browser.cancel'), requestId: IdSchema }).strict(),
  z.object({ type: z.literal('browser.heal.result'), requestId: IdSchema, proposal: BrowserHealProposalSchema.optional(), error: ErrorSchema.optional() }).strict(),
  z.object({ type: z.literal('hooks.invalidated'), requestId: IdSchema, ok: z.boolean(), error: ErrorSchema.optional() }).strict(),
  z.object({ type: z.literal('memory.result'), requestId: IdSchema, ok: z.boolean(), status: MemoryStatusSnapshotIpcSchema.optional(), error: ErrorSchema.optional() }).strict(),
  z.object({ type: z.literal('worker.error'), message: ErrorSchema }).strict()
]);

export const WorkerMessageSchema = WorkerMessageBaseSchema.superRefine((value, context) => {
  if (serializedIpcBytes(value) > MAX_WORKER_MESSAGE_BYTES) {
    context.addIssue({ code: 'custom', message: 'Worker message exceeds the IPC size limit.' });
  }
});
export type WorkerMessage = z.infer<typeof WorkerMessageSchema>;
