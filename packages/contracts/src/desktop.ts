import { z } from 'zod';
import type { AgentEvent } from './agent';
import type { ConversationMessageCreatedEvent, Message } from './messages';
import { TeamMemberDefinitionSchema } from './orchestration';
import type { OrchestrationEvent, TeamSnapshot, TeamStatusSnapshot, WorkflowRunSnapshot } from './orchestration';
import type { ProviderSettings, SessionMeta } from './persistence';
import { PermissionPolicyDocumentSchema, SESSION_TITLE_MAX_LENGTH } from './persistence';
import { JsonValueSchema } from './execution-scope';
import type { WorkspaceChanges } from './workspace';
import { ExtensionSettingsSchema } from './integrations';
import type { ExtensionSettings, ExtensionStatus, SkillDetail, SkillOperationResult } from './integrations';
import { attachmentPreviewText, FileAttachmentSchema, ImageContentBlockSchema, MAX_FILE_ATTACHMENTS, MAX_TOTAL_ATTACHMENT_TEXT } from './messages';
import type { AttachmentSelection, ImageContentBlock } from './messages';
import {
  BROWSER_RECORDING_PARAM_NAME_PATTERN,
  BrowserFramePathSchema,
  BrowserRecordingDocumentSchema,
  BrowserRecordingIdSchema
} from './browser-recording';
import type { HookSettingsSnapshot } from './hooks';
import type {
  ChannelBinding,
  ChannelDeliveryReceipt,
  ChannelInstance,
  ChannelInstanceHealth,
  ChannelPairing
} from '@desktop-agent/channel-core';
export type { ChannelDeliveryReceipt } from '@desktop-agent/channel-core';
import { MemorySettingsSchema } from './memory';
import type { MemorySettings, MemoryStatusSnapshot } from './memory';
import { MemoryCandidateReviewEditSchema } from './memory-candidate';
import type {
  SaveScheduleInputContract,
  ScheduleContract,
  ScheduleEventContract,
  ScheduleRunContract
} from './scheduler';

export const MAX_IMAGE_ATTACHMENTS = 4;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export const CreateSessionInputSchema = z.object({
  title: z.string().trim().min(1).max(SESSION_TITLE_MAX_LENGTH),
  workingDirectory: z.string().trim().min(1).max(4_096).optional()
});

export const RenameSessionInputSchema = z.object({
  sessionId: z.string(),
  title: z.string().trim().min(1).max(SESSION_TITLE_MAX_LENGTH)
});

export const BindSessionProjectInputSchema = z.object({
  sessionId: z.string().min(1),
  workingDirectory: z.string().trim().min(1).max(4_096)
});

export const StartTurnInputSchema = z.object({
  sessionId: z.string(),
  text: z.string().trim().max(100_000),
  providerId: z.string().trim().min(1),
  model: z.string().trim().min(1),
  images: z.array(ImageContentBlockSchema).max(MAX_IMAGE_ATTACHMENTS).default([]),
  files: z.array(FileAttachmentSchema).max(MAX_FILE_ATTACHMENTS).default([])
}).strict().refine((input) => input.text.trim().length > 0 || input.images.length > 0 || input.files.length > 0, {
  message: 'A turn must contain text or at least one attachment.'
}).refine((input) => input.files.reduce((sum, file) => sum + attachmentPreviewText(file).length, 0) <= MAX_TOTAL_ATTACHMENT_TEXT, {
  message: '附件文本总量超过 200,000 字符，请减少附件后重试。'
});

export const BrowserActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('open'), url: z.string().url() }),
  z.object({ action: z.literal('new_page'), url: z.string().url() }),
  z.object({ action: z.literal('pages') }),
  z.object({ action: z.literal('select_page'), pageId: z.number().int().positive() }),
  z.object({ action: z.literal('close_page'), pageId: z.number().int().positive() }),
  z.object({
    action: z.literal('record_start'),
    name: z.string().trim().min(1).max(120).optional(),
    mode: z.enum(['agent_trace', 'user_demo']).default('agent_trace')
  }),
  z.object({ action: z.literal('record_stop') }),
  z.object({ action: z.literal('record_cancel') }),
  z.object({ action: z.literal('recordings') }),
  z.object({ action: z.literal('record_get'), recordingId: BrowserRecordingIdSchema }),
  z.object({ action: z.literal('record_delete'), recordingId: BrowserRecordingIdSchema }),
  z.object({
    action: z.literal('replay'),
    recordingId: BrowserRecordingIdSchema,
    params: z.record(
      z.string().regex(BROWSER_RECORDING_PARAM_NAME_PATTERN),
      z.union([z.string().max(4_000), z.number(), z.boolean()])
    ).default({}),
    maxRetries: z.number().int().min(0).max(3).default(2),
    retryDelayMs: z.number().int().min(100).max(2_000).default(250),
    runId: z.string().regex(/^brun_[a-zA-Z0-9_-]{8,100}$/u).optional(),
    resumeRunId: z.string().regex(/^brun_[a-zA-Z0-9_-]{8,100}$/u).optional(),
    confirmUnsafeResume: z.boolean().default(false)
  }),
  z.object({ action: z.literal('read'), maxNodes: z.number().int().min(20).max(2_000).default(300), frame: BrowserFramePathSchema.optional() }),
  z.object({ action: z.literal('eval'), js: z.string().trim().min(1).max(20_000) }),
  z.object({
    action: z.literal('wait'),
    selector: z.string().trim().min(1).max(2_000).optional(),
    ref: z.string().regex(/^e[1-9][0-9]*$/u).optional(),
    frame: BrowserFramePathSchema.optional(),
    state: z.enum(['attached', 'detached', 'visible', 'hidden']).default('visible'),
    timeoutMs: z.number().int().min(100).max(30_000).default(5_000)
  }),
  z.object({
    action: z.literal('scroll'),
    selector: z.string().trim().min(1).max(2_000).optional(),
    ref: z.string().regex(/^e[1-9][0-9]*$/u).optional(),
    frame: BrowserFramePathSchema.optional(),
    deltaX: z.number().int().min(-100_000).max(100_000).default(0),
    deltaY: z.number().int().min(-100_000).max(100_000).default(600)
  }),
  z.object({ action: z.literal('click'), selector: z.string().trim().min(1).max(2_000).optional(), ref: z.string().regex(/^e[1-9][0-9]*$/u).optional(), frame: BrowserFramePathSchema.optional() }),
  z.object({ action: z.literal('hover'), selector: z.string().trim().min(1).max(2_000).optional(), ref: z.string().regex(/^e[1-9][0-9]*$/u).optional(), frame: BrowserFramePathSchema.optional() }),
  z.object({ action: z.literal('type'), selector: z.string().trim().min(1).max(2_000).optional(), ref: z.string().regex(/^e[1-9][0-9]*$/u).optional(), frame: BrowserFramePathSchema.optional(), text: z.string().max(100_000), submit: z.boolean().default(false) }),
  z.object({
    action: z.literal('press'),
    selector: z.string().trim().min(1).max(2_000).optional(),
    ref: z.string().regex(/^e[1-9][0-9]*$/u).optional(),
    frame: BrowserFramePathSchema.optional(),
    key: z.union([
      z.enum(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Space']),
      z.string().length(1)
    ])
  }),
  z.object({
    action: z.literal('select'),
    selector: z.string().trim().min(1).max(2_000).optional(),
    ref: z.string().regex(/^e[1-9][0-9]*$/u).optional(),
    frame: BrowserFramePathSchema.optional(),
    values: z.array(z.string().max(1_000)).min(1).max(20)
  }),
  z.object({
    action: z.literal('upload'),
    selector: z.string().trim().min(1).max(2_000).optional(),
    ref: z.string().regex(/^e[1-9][0-9]*$/u).optional(),
    frame: BrowserFramePathSchema.optional(),
    paths: z.array(z.string().trim().min(1).max(4_096)).min(1).max(10)
  }),
  z.object({ action: z.literal('back') }),
  z.object({ action: z.literal('reload') }),
  z.object({ action: z.literal('screenshot'), fullPage: z.boolean().default(false) }),
  z.object({ action: z.literal('download'), url: z.string().url(), filename: z.string().trim().min(1).max(255).optional() }),
  z.object({ action: z.literal('downloads') }),
  z.object({
    action: z.literal('console'),
    level: z.enum(['debug', 'info', 'warning', 'error']).optional(),
    limit: z.number().int().min(1).max(200).default(80),
    clear: z.boolean().default(false)
  }),
  z.object({
    action: z.literal('network'),
    failedOnly: z.boolean().default(false),
    urlContains: z.string().trim().min(1).max(500).optional(),
    resourceType: z.enum([
      'mainFrame', 'subFrame', 'stylesheet', 'script', 'image', 'font',
      'object', 'xhr', 'ping', 'cspReport', 'media', 'webSocket', 'other'
    ]).optional(),
    limit: z.number().int().min(1).max(200).default(80),
    clear: z.boolean().default(false)
  }),
  z.object({
    action: z.literal('errors'),
    kind: z.enum(['exception', 'failed_load', 'log']).optional(),
    limit: z.number().int().min(1).max(100).default(50),
    clear: z.boolean().default(false)
  }),
  z.object({ action: z.literal('cookies'), includeValues: z.boolean().default(false) })
]).superRefine((action, context) => {
  if (action.action === 'replay' && action.runId && action.resumeRunId) {
    context.addIssue({ code: 'custom', message: 'Provide either runId or resumeRunId, not both.' });
  }
  if (!['wait', 'scroll', 'click', 'hover', 'type', 'press', 'select', 'upload'].includes(action.action)) return;
  const target = action as { action: string; selector?: string; ref?: string };
  if (target.selector && target.ref) {
    context.addIssue({ code: 'custom', message: 'Provide either selector or ref, not both.' });
  }
  if (['wait', 'click', 'hover', 'type', 'select', 'upload'].includes(action.action) && !target.selector && !target.ref) {
    context.addIssue({ code: 'custom', message: `Browser ${action.action} requires selector or ref.` });
  }
});
export type BrowserAction = z.infer<typeof BrowserActionSchema>;

export const SessionIdInputSchema = z.object({ sessionId: z.string() });
export const ApprovalInputSchema = z.object({
  requestId: z.string(), allow: z.boolean(),
  scope: z.enum(['once', 'session', 'similar', 'conversation']).default('once')
});
export const WorkflowRunActionInputSchema = z.object({
  sessionId: z.string().min(1),
  workflowId: z.string().min(1)
});
export const ListTeamsInputSchema = z.object({
  workspace: z.string().trim().min(1).max(4_096).optional()
}).strict();
export const SaveTeamInputSchema = z.object({
  id: z.string().trim().min(1).max(128).regex(/^[a-z][a-z0-9_-]*$/u),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2_000).optional(),
  workspace: z.string().trim().min(1).max(4_096),
  members: z.array(TeamMemberDefinitionSchema).min(1).max(32),
  maxConcurrency: z.number().int().min(1).max(16).default(3),
  expectedRevision: z.number().int().positive().optional()
}).strict();
export const DeleteTeamInputSchema = z.object({ teamId: z.string().min(1).max(128) }).strict();
export const SetTeamMemberEnabledInputSchema = z.object({
  teamId: z.string().min(1).max(128),
  memberId: z.string().min(1).max(128),
  enabled: z.boolean()
}).strict();
export const McpServerIdInputSchema = z.object({ serverId: z.string().trim().min(1).max(64) });
export const SkillPathInputSchema = z.object({ path: z.string().trim().min(1).max(4_096) });
export const CreateSkillInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(4_000),
  instructions: z.string().max(120_000).default('')
});
export const UpdateSkillInputSchema = z.object({
  path: z.string().trim().min(1).max(4_096),
  content: z.string().min(1).max(120_000)
});
export const ImportSkillInputSchema = z.object({
  replacePath: z.string().trim().min(1).max(4_096).optional()
});
export const GetExtensionStatusInputSchema = z.object({ workingDirectory: z.string().trim().min(1).max(4_096).optional() });
export const GetHookStatusInputSchema = z.object({ workingDirectory: z.string().trim().min(1).max(4_096).optional() });
export const HookProjectActionInputSchema = z.object({
  workingDirectory: z.string().trim().min(1).max(4_096)
});
export const OpenHookConfigInputSchema = z.object({
  source: z.enum(['user', 'project']),
  workingDirectory: z.string().trim().min(1).max(4_096).optional()
}).superRefine((input, context) => {
  if (input.source === 'project' && !input.workingDirectory) {
    context.addIssue({ code: 'custom', message: 'Project hooks require a working directory.' });
  }
});

export const SaveSettingsInputSchema = z.object({
  activeProviderId: z.string().min(1),
  provider: z.object({
    id: z.string().min(1),
    name: z.string().trim().min(1),
    protocol: z.literal('openai_chat_completions'),
    baseUrl: z.string().url(),
    model: z.string().min(1),
    models: z.array(z.string().trim().min(1)).min(1),
    contextWindowTokens: z.number().int().min(8_192).max(2_000_000),
    maxOutputTokens: z.number().int().min(256).max(128_000)
  }),
  utilityModel: z.object({ providerId: z.string().min(1), model: z.string().min(1) }),
  permissions: z.object({ mode: z.enum(['ask', 'auto', 'yolo']) }).strict().optional(),
  apiKey: z.string().trim().min(1).optional()
});

export const GetPermissionGovernanceInputSchema = z.object({
  workingDirectory: z.string().trim().min(1).max(4_096).optional(),
  sessionId: z.string().min(1).max(256).optional(),
  limit: z.number().int().min(1).max(200).default(50)
}).strict();

export const SavePermissionPolicyInputSchema = z.object({
  scope: z.enum(['global', 'workspace']),
  workingDirectory: z.string().trim().min(1).max(4_096).optional(),
  mode: z.enum(['ask', 'auto', 'yolo']),
  document: PermissionPolicyDocumentSchema
}).strict().superRefine((input, context) => {
  if (input.scope === 'workspace' && !input.workingDirectory) {
    context.addIssue({ code: 'custom', path: ['workingDirectory'], message: 'Workspace policy requires a working directory.' });
  }
});

export const PermissionPolicyProfileSnapshotSchema = z.object({
  scope: z.enum(['global', 'workspace']),
  mode: z.enum(['ask', 'auto', 'yolo']),
  document: PermissionPolicyDocumentSchema,
  revision: z.number().int().nonnegative(),
  updatedAt: z.string().datetime().optional()
}).strict();
export type PermissionPolicyProfileSnapshot = z.infer<typeof PermissionPolicyProfileSnapshotSchema>;

export const PermissionDecisionAuditItemSchema = z.object({
  id: z.string().min(1).max(256),
  createdAt: z.string().datetime(),
  sessionId: z.string().min(1).max(256),
  laneId: z.string().max(256).optional(),
  runId: z.string().max(256).optional(),
  actorKind: z.enum(['main', 'subagent', 'workflow', 'team_member', 'channel_user']),
  actorId: z.string().max(256).optional(),
  triggerKind: z.enum(['user', 'api', 'scheduler', 'workflow', 'subagent', 'team_member', 'resume', 'channel_message']),
  toolName: z.string().min(1).max(256),
  toolSource: z.enum(['native', 'mcp', 'browser', 'memory', 'orchestration', 'skill', 'hook', 'channel']),
  effect: z.enum(['allow', 'ask', 'deny']),
  locked: z.boolean(),
  source: z.enum(['security_boundary', 'hard_floor', 'mandatory_approval', 'user_policy', 'session_grant', 'mode', 'baseline']),
  reasonCode: z.string().min(1).max(256),
  policyRuleId: z.string().max(256).optional(),
  requestFingerprint: z.string().min(1).max(256),
  risk: z.enum(['low', 'medium', 'high', 'critical']),
  metadata: JsonValueSchema.optional()
}).strict();
export type PermissionDecisionAuditItem = z.infer<typeof PermissionDecisionAuditItemSchema>;

export const PermissionGovernanceSnapshotSchema = z.object({
  global: PermissionPolicyProfileSnapshotSchema,
  workspace: PermissionPolicyProfileSnapshotSchema.optional(),
  recentDecisions: z.array(PermissionDecisionAuditItemSchema).max(200)
}).strict();
export type PermissionGovernanceSnapshot = z.infer<typeof PermissionGovernanceSnapshotSchema>;

export const ListModelsInputSchema = z.object({
  protocol: z.literal('openai_chat_completions'),
  baseUrl: z.string().url(),
  apiKey: z.string().trim().min(1).optional()
});

export const SaveExtensionSettingsInputSchema = ExtensionSettingsSchema;
export const SaveMemorySettingsInputSchema = MemorySettingsSchema;
export const GetMemoryStatusInputSchema = z.object({
  workingDirectory: z.string().trim().min(1).max(4_096).optional()
});
export const RebuildMemoryIndexInputSchema = z.object({
  scope: z.enum(['global', 'project']),
  workingDirectory: z.string().trim().min(1).max(4_096).optional()
}).superRefine((input, context) => {
  if (input.scope === 'project' && !input.workingDirectory) {
    context.addIssue({ code: 'custom', message: 'Project Memory requires a working directory.' });
  }
});
export const RebuildSemanticMemoryIndexInputSchema = z.object({
  workingDirectory: z.string().trim().min(1).max(4_096).optional()
});
export const DeleteMemoryEntryInputSchema = z.object({
  scope: z.enum(['global', 'project']),
  entryId: z.string().trim().min(1).max(512),
  workingDirectory: z.string().trim().min(1).max(4_096).optional()
}).superRefine((input, context) => {
  if (input.scope === 'project' && !input.workingDirectory) {
    context.addIssue({ code: 'custom', message: 'Project Memory requires a working directory.' });
  }
});
export const AcceptMemoryCandidateInputSchema = z.object({
  candidateId: z.string().trim().min(1).max(512),
  workingDirectory: z.string().trim().min(1).max(4_096).optional(),
  userConfirmed: z.literal(true),
  edit: MemoryCandidateReviewEditSchema.optional()
});
export const RejectMemoryCandidateInputSchema = z.object({
  candidateId: z.string().trim().min(1).max(512),
  workingDirectory: z.string().trim().min(1).max(4_096).optional()
});

export const BrowserDockLayoutSchema = z.object({
  sessionId: z.string().min(1),
  overlayOpen: z.boolean(),
  bounds: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number()
  }).nullable()
});

export const BrowserDockActionSchema = z.object({
  sessionId: z.string().min(1),
  type: z.enum(['back', 'forward', 'reload', 'select', 'close-tab', 'close']),
  pageId: z.number().int().positive().optional()
});

export const BrowserDockTabSchema = z.object({
  pageId: z.number().int().positive(), title: z.string().max(2_000), url: z.string().max(20_000), active: z.boolean()
}).strict();
export type BrowserDockTab = z.infer<typeof BrowserDockTabSchema>;

export const BrowserDockStateSchema = z.object({
  sessionId: z.string().min(1).max(256), pages: z.array(BrowserDockTabSchema).max(500),
  canGoBack: z.boolean(), canGoForward: z.boolean()
}).strict();
export type BrowserDockState = z.infer<typeof BrowserDockStateSchema>;

export const BrowserRecordingRegistryInputSchema = z.object({
  workingDirectory: z.string().trim().min(1).max(4_096).optional()
}).strict();

export const BrowserRecordingRegistryActionInputSchema = z.object({
  recordingId: BrowserRecordingIdSchema,
  workingDirectory: z.string().trim().min(1).max(4_096)
}).strict();

export const BrowserRecordingRegistryItemSchema = z.object({
  id: BrowserRecordingIdSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(2_000).optional(),
  source: z.enum(['builtin', 'user', 'project']),
  trust: z.enum(['not_required', 'trusted', 'untrusted']),
  overriddenSources: z.array(z.enum(['builtin', 'user', 'project'])).max(3),
  domains: z.array(z.string().max(253)).max(64),
  effects: z.array(z.string().max(200)).max(32),
  highRisk: z.boolean(),
  stepCount: z.number().int().nonnegative().max(200),
  revision: z.number().int().positive(),
  contentHash: z.string().max(128),
  updatedAt: z.string().datetime()
}).strict();
export type BrowserRecordingRegistryItem = z.infer<typeof BrowserRecordingRegistryItemSchema>;

export const BrowserRecordingRegistrySnapshotSchema = z.object({
  userDirectory: z.string().min(1).max(4_096),
  projectDirectory: z.string().min(1).max(4_096).optional(),
  recordings: z.array(BrowserRecordingRegistryItemSchema).max(1_000)
}).strict();
export type BrowserRecordingRegistrySnapshot = z.infer<typeof BrowserRecordingRegistrySnapshotSchema>;

export const BrowserRecordingStudioInputSchema = z.object({
  recordingId: BrowserRecordingIdSchema,
  workingDirectory: z.string().trim().min(1).max(4_096).optional()
}).strict();

export const SaveBrowserRecordingInputSchema = BrowserRecordingStudioInputSchema.extend({
  expectedRevision: z.number().int().positive(),
  expectedHash: z.string().min(1).max(128),
  document: BrowserRecordingDocumentSchema
}).strict();

export const DuplicateBrowserRecordingInputSchema = BrowserRecordingStudioInputSchema.extend({
  name: z.string().trim().min(1).max(120).optional()
}).strict();

export const BrowserRecordingTimelineItemSchema = z.object({
  index: z.number().int().nonnegative(),
  stepId: z.string().min(1).max(160),
  action: z.string().min(1).max(40),
  label: z.string().max(500).optional(),
  target: z.string().max(2_000).optional(),
  frame: z.array(z.string().max(2_000)).max(16).optional()
}).strict();

export const BrowserRecordingRevisionItemSchema = z.object({
  revision: z.number().int().positive(),
  contentHash: z.string().max(128),
  updatedAt: z.string().datetime(),
  current: z.boolean()
}).strict();

export const BrowserReplayDebugEntrySchema = z.object({
  runId: z.string().min(1).max(160),
  timestamp: z.string().datetime(),
  stepId: z.string().min(1).max(160),
  stepIndex: z.number().int().nonnegative(),
  action: z.string().min(1).max(40),
  state: z.string().min(1).max(80),
  attempt: z.number().int().positive().optional(),
  selector: z.string().max(2_000).optional(),
  confidence: z.number().min(0).max(1).optional()
}).strict();

export const BrowserHealDiffSchema = z.object({
  runId: z.string().min(1).max(160),
  stepId: z.string().min(1).max(160),
  before: z.string().max(2_000).optional(),
  after: z.string().min(1).max(2_000),
  confidence: z.number().min(0).max(1).optional(),
  verified: z.boolean(),
  timestamp: z.string().datetime()
}).strict();

export const BrowserRecordingStudioDetailSchema = z.object({
  document: BrowserRecordingDocumentSchema,
  source: z.enum(['builtin', 'user', 'project']),
  trust: z.enum(['not_required', 'trusted', 'untrusted']),
  editable: z.boolean(),
  timeline: z.array(BrowserRecordingTimelineItemSchema).max(200),
  revisions: z.array(BrowserRecordingRevisionItemSchema).max(1_000),
  replay: z.array(BrowserReplayDebugEntrySchema).max(5_000),
  heals: z.array(BrowserHealDiffSchema).max(1_000)
}).strict();
export type BrowserRecordingStudioDetail = z.infer<typeof BrowserRecordingStudioDetailSchema>;

export const BrowserSecretRequestSchema = z.object({
  requestId: z.string().min(1).max(256), name: z.string().min(1).max(256), description: z.string().max(4_000).optional()
}).strict();

export const TerminalSecretRequestSchema = z.object({
  requestId: z.string().min(1).max(256), name: z.string().min(1).max(256), description: z.string().max(4_000).optional()
}).strict();

export const ResolveTerminalSecretInputSchema = z.object({
  requestId: z.string().min(1).max(256),
  action: z.enum(['submit', 'import', 'cancel']),
  value: z.string().max(100_000).optional(),
  remember: z.boolean().default(true)
}).strict().superRefine((input, context) => {
  if (input.action === 'submit' && !input.value) {
    context.addIssue({ code: 'custom', path: ['value'], message: 'Secret value is required.' });
  }
});

export type SessionCompactionRecord = {
  id: string;
  createdAt: string;
  summary: string;
  tokensBefore: number;
};

export type ChannelDeliverySummary = {
  id: string; instanceId: string; bindingId?: string; conversationId: string; threadId?: string;
  mode?: 'reply' | 'proactive' | 'system'; status: 'pending' | 'sending' | 'delivered' | 'failed' | 'unknown';
  attemptCount: number; createdAt: string; deliveredAt?: string; nativeMessageId?: string; lastError?: string;
};

export type ChannelSettingsSnapshot = {
  instances: ChannelInstance[];
  bindings: ChannelBinding[];
  pairings: Array<Omit<ChannelPairing, 'codeHash'>>;
  deliveries: ChannelDeliverySummary[];
  health: Array<{ instanceId: string; health: ChannelInstanceHealth }>;
};

const ChannelEntityIdSchema = z.string().trim().min(1).max(256);
const ChannelSecretValueSchema = z.string().min(1).max(100_000);
export const SaveChannelSecretsInputSchema = z.object({
  instanceId: ChannelEntityIdSchema,
  secrets: z.object({
    botToken: ChannelSecretValueSchema.optional(),
    appSecret: ChannelSecretValueSchema.optional(),
    verificationToken: ChannelSecretValueSchema.optional(),
    encryptKey: ChannelSecretValueSchema.optional()
  }).strict().refine((secrets) => Object.keys(secrets).length > 0, {
    message: 'At least one Channel secret is required.'
  })
}).strict();
export type SaveChannelSecretsInput = z.infer<typeof SaveChannelSecretsInputSchema>;
export type ChannelSecretReferences = Partial<Record<keyof SaveChannelSecretsInput['secrets'], string>>;

const ChannelInstanceDraftSchema = z.object({
  id: ChannelEntityIdSchema,
  kind: z.enum(['telegram', 'feishu']),
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean(),
  config: z.record(z.string().min(1).max(128), JsonValueSchema),
  secretRefs: z.record(
    z.string().min(1).max(128),
    z.string().regex(
      /^secret:\/\/env\/[A-Z_][A-Z0-9_]*$/u,
      'Channel secrets must use secret://env/VARIABLE_NAME references.'
    )
  )
}).strict();

const ChannelBindingDraftSchema = z.object({
  id: ChannelEntityIdSchema,
  instanceId: ChannelEntityIdSchema,
  conversation: z.object({
    id: ChannelEntityIdSchema,
    threadId: ChannelEntityIdSchema.optional(),
    type: z.enum(['direct', 'group'])
  }).strict(),
  routing: z.object({
    sessionMode: z.enum(['persistent', 'per_thread', 'stateless']),
    sessionId: ChannelEntityIdSchema.optional(),
    workspaceRoot: z.string().trim().min(1).max(4_096).optional(),
    providerId: ChannelEntityIdSchema.optional(),
    model: z.string().trim().min(1).max(256).optional(),
    instructions: z.array(z.string().max(10_000)).max(20).optional(),
    profile: ChannelEntityIdSchema.optional()
  }).strict(),
  policy: z.object({
    enabled: z.boolean(),
    requireMention: z.boolean(),
    queueMode: z.enum(['queue', 'reject', 'interrupt']),
    allowedSenders: z.array(ChannelEntityIdSchema).max(1_000).optional(),
    allowAttachments: z.boolean()
  }).strict()
}).strict();

export const DesktopChannelMutationSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('instance.save'),
    instance: ChannelInstanceDraftSchema,
    expectedRevision: z.number().int().positive().optional()
  }).strict(),
  z.object({
    action: z.literal('instance.delete'),
    instanceId: ChannelEntityIdSchema,
    expectedRevision: z.number().int().positive().optional()
  }).strict(),
  z.object({
    action: z.literal('binding.save'),
    binding: ChannelBindingDraftSchema,
    expectedRevision: z.number().int().positive().optional()
  }).strict(),
  z.object({
    action: z.literal('binding.delete'),
    bindingId: ChannelEntityIdSchema,
    expectedRevision: z.number().int().positive().optional()
  }).strict(),
  z.object({ action: z.literal('pairing.approve'), pairingId: ChannelEntityIdSchema, binding: ChannelBindingDraftSchema }).strict(),
  z.object({ action: z.literal('pairing.reject'), pairingId: ChannelEntityIdSchema }).strict(),
  z.object({
    action: z.literal('channel.test'),
    instanceId: ChannelEntityIdSchema,
    bindingId: ChannelEntityIdSchema.optional(),
    conversationId: ChannelEntityIdSchema.optional(),
    threadId: ChannelEntityIdSchema.optional(),
    text: z.string().trim().min(1).max(20_000)
  }).strict().refine((input) => Boolean(input.bindingId || input.conversationId), {
    message: 'Channel test requires a bindingId or conversationId.'
  })
]);
export type DesktopChannelMutation = z.infer<typeof DesktopChannelMutationSchema>;

export type DesktopApi = {
  listSessions(): Promise<SessionMeta[]>;
  createSession(input: z.input<typeof CreateSessionInputSchema>): Promise<SessionMeta | null>;
  bindSessionProject(input: z.input<typeof BindSessionProjectInputSchema>): Promise<SessionMeta>;
  renameSession(input: z.input<typeof RenameSessionInputSchema>): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  loadMessages(sessionId: string): Promise<Message[]>;
  loadSessionCompactions(sessionId: string): Promise<SessionCompactionRecord[]>;
  exportSessionTrajectory(sessionId: string): Promise<{ canceled: boolean; path?: string }>;
  getWorkspaceChanges(sessionId: string): Promise<WorkspaceChanges>;
  startTurn(input: z.input<typeof StartTurnInputSchema>): Promise<void>;
  cancelTurn(sessionId: string): Promise<void>;
  listWorkflowRuns(sessionId: string): Promise<WorkflowRunSnapshot[]>;
  cancelWorkflow(input: z.input<typeof WorkflowRunActionInputSchema>): Promise<void>;
  resumeWorkflow(input: z.input<typeof WorkflowRunActionInputSchema>): Promise<void>;
  listTeams(input?: z.input<typeof ListTeamsInputSchema>): Promise<TeamSnapshot[]>;
  getTeamStatus(input: z.input<typeof DeleteTeamInputSchema>): Promise<TeamStatusSnapshot>;
  saveTeam(input: z.input<typeof SaveTeamInputSchema>): Promise<TeamSnapshot>;
  deleteTeam(input: z.input<typeof DeleteTeamInputSchema>): Promise<void>;
  setTeamMemberEnabled(input: z.input<typeof SetTeamMemberEnabledInputSchema>): Promise<TeamSnapshot>;
  listSchedules(): Promise<ScheduleContract[]>;
  getSchedule(input: { scheduleId: string }): Promise<ScheduleContract>;
  saveSchedule(input: SaveScheduleInputContract): Promise<ScheduleContract>;
  deleteSchedule(input: { scheduleId: string }): Promise<void>;
  setScheduleEnabled(input: { scheduleId: string; enabled: boolean; expectedRevision?: number }): Promise<ScheduleContract>;
  runScheduleNow(input: { scheduleId: string }): Promise<ScheduleRunContract>;
  listScheduleRuns(input: { scheduleId: string }): Promise<ScheduleRunContract[]>;
  cancelScheduleRun(input: { runId: string }): Promise<void>;
  getChannelSettings(): Promise<ChannelSettingsSnapshot>;
  saveChannelSecrets(input: SaveChannelSecretsInput): Promise<ChannelSecretReferences>;
  mutateChannel(input: DesktopChannelMutation): Promise<ChannelDeliveryReceipt | ChannelSettingsSnapshot>;
  resolveApproval(input: z.input<typeof ApprovalInputSchema>): Promise<void>;
  chooseDirectory(): Promise<string | null>;
  chooseImages(): Promise<ImageContentBlock[]>;
  chooseFiles(mode: 'files' | 'folder'): Promise<AttachmentSelection>;
  importAttachments(files: File[]): Promise<AttachmentSelection>;
  hasClipboardFiles(): boolean;
  pasteFiles(): Promise<AttachmentSelection>;
  getSettings(): Promise<ProviderSettings>;
  listModels(input: z.input<typeof ListModelsInputSchema>): Promise<string[]>;
  saveSettings(input: z.input<typeof SaveSettingsInputSchema>): Promise<ProviderSettings>;
  getPermissionGovernance(input?: z.input<typeof GetPermissionGovernanceInputSchema>): Promise<PermissionGovernanceSnapshot>;
  savePermissionPolicy(input: z.input<typeof SavePermissionPolicyInputSchema>): Promise<PermissionGovernanceSnapshot>;
  getExtensionStatus(input?: z.input<typeof GetExtensionStatusInputSchema>): Promise<ExtensionStatus>;
  getSkillDetail(input: z.input<typeof SkillPathInputSchema>): Promise<SkillDetail>;
  createSkill(input: z.input<typeof CreateSkillInputSchema>): Promise<SkillOperationResult>;
  updateSkill(input: z.input<typeof UpdateSkillInputSchema>): Promise<SkillOperationResult>;
  importSkill(input?: z.input<typeof ImportSkillInputSchema>): Promise<SkillOperationResult>;
  exportSkill(input: z.input<typeof SkillPathInputSchema>): Promise<SkillOperationResult>;
  trashSkill(input: z.input<typeof SkillPathInputSchema>): Promise<SkillOperationResult>;
  saveExtensionSettings(input: z.input<typeof SaveExtensionSettingsInputSchema>): Promise<ExtensionSettings>;
  saveMemorySettings(input: z.input<typeof SaveMemorySettingsInputSchema>): Promise<MemorySettings>;
  getMemoryStatus(input?: z.input<typeof GetMemoryStatusInputSchema>): Promise<MemoryStatusSnapshot>;
  rebuildMemoryIndex(input: z.input<typeof RebuildMemoryIndexInputSchema>): Promise<MemoryStatusSnapshot>;
  rebuildSemanticMemoryIndex(input?: z.input<typeof RebuildSemanticMemoryIndexInputSchema>): Promise<MemoryStatusSnapshot>;
  deleteMemoryEntry(input: z.input<typeof DeleteMemoryEntryInputSchema>): Promise<MemoryStatusSnapshot>;
  acceptMemoryCandidate(input: z.input<typeof AcceptMemoryCandidateInputSchema>): Promise<MemoryStatusSnapshot>;
  rejectMemoryCandidate(input: z.input<typeof RejectMemoryCandidateInputSchema>): Promise<MemoryStatusSnapshot>;
  probeChromeBrowser(port?: number): Promise<{ ok: true; browser: string } | { ok: false; error: string }>;
  setBrowserDockLayout(input: z.input<typeof BrowserDockLayoutSchema>): Promise<void>;
  browserDockAction(input: z.input<typeof BrowserDockActionSchema>): Promise<void>;
  listBrowserRecordings(input?: z.input<typeof BrowserRecordingRegistryInputSchema>): Promise<BrowserRecordingRegistrySnapshot>;
  trustProjectBrowserRecording(input: z.input<typeof BrowserRecordingRegistryActionInputSchema>): Promise<BrowserRecordingRegistrySnapshot>;
  revokeProjectBrowserRecordingTrust(input: z.input<typeof BrowserRecordingRegistryActionInputSchema>): Promise<BrowserRecordingRegistrySnapshot>;
  deleteBrowserRecording(input: z.input<typeof BrowserRecordingRegistryActionInputSchema>): Promise<BrowserRecordingRegistrySnapshot>;
  getBrowserRecordingStudio(input: z.input<typeof BrowserRecordingStudioInputSchema>): Promise<BrowserRecordingStudioDetail>;
  saveBrowserRecording(input: z.input<typeof SaveBrowserRecordingInputSchema>): Promise<BrowserRecordingStudioDetail>;
  duplicateBrowserRecording(input: z.input<typeof DuplicateBrowserRecordingInputSchema>): Promise<BrowserRecordingStudioDetail>;
  resolveBrowserSecret(input: { requestId: string; value?: string }): Promise<void>;
  resolveTerminalSecret(input: z.input<typeof ResolveTerminalSecretInputSchema>): Promise<void>;
  connectMcpOAuth(input: z.input<typeof McpServerIdInputSchema>): Promise<void>;
  disconnectMcpOAuth(input: z.input<typeof McpServerIdInputSchema>): Promise<void>;
  reconnectMcp(input: z.input<typeof McpServerIdInputSchema>): Promise<void>;
  trustMcpServer(input: z.input<typeof McpServerIdInputSchema>): Promise<void>;
  revokeMcpServerTrust(input: z.input<typeof McpServerIdInputSchema>): Promise<void>;
  getHookStatus(input?: z.input<typeof GetHookStatusInputSchema>): Promise<HookSettingsSnapshot>;
  reloadHooks(input?: z.input<typeof GetHookStatusInputSchema>): Promise<HookSettingsSnapshot>;
  trustProjectHooks(input: z.input<typeof HookProjectActionInputSchema>): Promise<HookSettingsSnapshot>;
  disableProjectHooks(input: z.input<typeof HookProjectActionInputSchema>): Promise<HookSettingsSnapshot>;
  openHookConfig(input: z.input<typeof OpenHookConfigInputSchema>): Promise<void>;
  onAgentEvent(listener: (event: AgentEvent) => void): () => void;
  onOrchestrationEvent(listener: (event: OrchestrationEvent) => void): () => void;
  onScheduleEvent(listener: (event: ScheduleEventContract) => void): () => void;
  onConversationMessageCreated(listener: (event: ConversationMessageCreatedEvent) => void): () => void;
  onSessionsChanged(listener: () => void): () => void;
  onExtensionsChanged(listener: () => void): () => void;
  onBrowserSecretRequest(listener: (request: { requestId: string; name: string; description?: string }) => void): () => void;
  onTerminalSecretRequest(listener: (request: { requestId: string; name: string; description?: string }) => void): () => void;
  onBrowserDockState(listener: (state: BrowserDockState | null) => void): () => void;
};

export const IPC = {
  listSessions: 'sessions:list',
  createSession: 'sessions:create',
  bindSessionProject: 'sessions:bind-project',
  renameSession: 'sessions:rename',
  deleteSession: 'sessions:delete',
  loadMessages: 'sessions:messages',
  loadSessionCompactions: 'sessions:compactions',
  exportSessionTrajectory: 'sessions:export-trajectory',
  getWorkspaceChanges: 'workspace:changes',
  startTurn: 'agent:start',
  cancelTurn: 'agent:cancel',
  listWorkflowRuns: 'orchestration:workflow-list',
  cancelWorkflow: 'orchestration:workflow-cancel',
  resumeWorkflow: 'orchestration:workflow-resume',
  listTeams: 'orchestration:team-list',
  getTeamStatus: 'orchestration:team-status',
  saveTeam: 'orchestration:team-save',
  deleteTeam: 'orchestration:team-delete',
  setTeamMemberEnabled: 'orchestration:team-member-enabled',
  listSchedules: 'scheduler:list',
  getSchedule: 'scheduler:get',
  saveSchedule: 'scheduler:save',
  deleteSchedule: 'scheduler:delete',
  setScheduleEnabled: 'scheduler:enabled',
  runScheduleNow: 'scheduler:run-now',
  listScheduleRuns: 'scheduler:runs-list',
  cancelScheduleRun: 'scheduler:run-cancel',
  getChannelSettings: 'channels:get',
  saveChannelSecrets: 'channels:secrets-save',
  mutateChannel: 'channels:mutate',
  scheduleEvent: 'scheduler:event',
  conversationMessageCreated: 'conversation:message-created',
  resolveApproval: 'agent:approval',
  chooseDirectory: 'system:choose-directory',
  chooseImages: 'system:choose-images',
  chooseFiles: 'system:choose-files',
  importAttachments: 'system:import-attachments',
  hasClipboardFiles: 'system:has-clipboard-files',
  pasteFiles: 'system:paste-files',
  getSettings: 'settings:get',
  listModels: 'models:list',
  saveSettings: 'settings:save',
  getPermissionGovernance: 'permissions:get',
  savePermissionPolicy: 'permissions:save',
  getExtensionStatus: 'extensions:status',
  getSkillDetail: 'extensions:skill-detail',
  createSkill: 'extensions:skill-create',
  updateSkill: 'extensions:skill-update',
  importSkill: 'extensions:skill-import',
  exportSkill: 'extensions:skill-export',
  trashSkill: 'extensions:skill-trash',
  saveExtensionSettings: 'extensions:save',
  saveMemorySettings: 'memory:settings-save',
  getMemoryStatus: 'memory:status',
  rebuildMemoryIndex: 'memory:rebuild-index',
  rebuildSemanticMemoryIndex: 'memory:semantic-rebuild-index',
  deleteMemoryEntry: 'memory:entry-delete',
  acceptMemoryCandidate: 'memory:candidate-accept',
  rejectMemoryCandidate: 'memory:candidate-reject',
  probeChromeBrowser: 'browser:chrome-probe',
  browserDockLayout: 'browser:dock-layout',
  browserDockAction: 'browser:dock-action',
  browserDockState: 'browser:dock-state',
  listBrowserRecordings: 'browser:recordings-list',
  trustProjectBrowserRecording: 'browser:recording-trust',
  revokeProjectBrowserRecordingTrust: 'browser:recording-revoke',
  deleteBrowserRecording: 'browser:recording-delete',
  getBrowserRecordingStudio: 'browser:recording-studio-get',
  saveBrowserRecording: 'browser:recording-studio-save',
  duplicateBrowserRecording: 'browser:recording-duplicate',
  browserSecretRequest: 'browser:secret-request',
  browserSecretResolve: 'browser:secret-resolve',
  terminalSecretRequest: 'terminal:secret-request',
  terminalSecretResolve: 'terminal:secret-resolve',
  connectMcpOAuth: 'extensions:mcp-oauth-connect',
  disconnectMcpOAuth: 'extensions:mcp-oauth-disconnect',
  reconnectMcp: 'extensions:mcp-reconnect',
  trustMcpServer: 'extensions:mcp-trust',
  revokeMcpServerTrust: 'extensions:mcp-trust-revoke',
  getHookStatus: 'hooks:status',
  reloadHooks: 'hooks:reload',
  trustProjectHooks: 'hooks:trust',
  disableProjectHooks: 'hooks:disable',
  openHookConfig: 'hooks:open-config',
  agentEvent: 'agent:event',
  orchestrationEvent: 'orchestration:event',
  sessionsChanged: 'sessions:changed',
  extensionsChanged: 'extensions:changed'
} as const;
