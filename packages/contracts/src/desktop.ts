import { z } from 'zod';
import type { AgentEvent } from './agent';
import type { Message } from './messages';
import type { OrchestrationEvent, WorkflowRunSnapshot } from './orchestration';
import type { ProviderSettings, SessionMeta } from './persistence';
import { SESSION_TITLE_MAX_LENGTH } from './persistence';
import type { WorkspaceChanges } from './workspace';
import { ExtensionSettingsSchema } from './extensions';
import type { ExtensionSettings, ExtensionStatus, SkillDetail, SkillOperationResult } from './extensions';
import { ImageContentBlockSchema } from './messages';
import type { ImageContentBlock, ToolResult } from './messages';
import { BROWSER_RECORDING_PARAM_NAME_PATTERN, BrowserRecordingIdSchema } from './browser-recording';

export const MAX_IMAGE_ATTACHMENTS = 4;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export const CreateSessionInputSchema = z.object({
  title: z.string().trim().min(1).max(SESSION_TITLE_MAX_LENGTH),
  workingDirectory: z.string().min(1)
});

export const RenameSessionInputSchema = z.object({
  sessionId: z.string(),
  title: z.string().trim().min(1).max(SESSION_TITLE_MAX_LENGTH)
});

export const StartTurnInputSchema = z.object({
  sessionId: z.string(),
  text: z.string().trim().max(100_000),
  providerId: z.string().trim().min(1),
  model: z.string().trim().min(1),
  images: z.array(ImageContentBlockSchema).max(MAX_IMAGE_ATTACHMENTS).default([])
}).refine((input) => input.text.trim().length > 0 || input.images.length > 0, {
  message: 'A turn must contain text or at least one image.'
});

export const BrowserActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('open'), url: z.string().url() }),
  z.object({ action: z.literal('new_page'), url: z.string().url() }),
  z.object({ action: z.literal('pages') }),
  z.object({ action: z.literal('select_page'), pageId: z.number().int().positive() }),
  z.object({ action: z.literal('close_page'), pageId: z.number().int().positive() }),
  z.object({ action: z.literal('record_start'), name: z.string().trim().min(1).max(120).optional() }),
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
    retryDelayMs: z.number().int().min(100).max(2_000).default(250)
  }),
  z.object({ action: z.literal('read'), maxNodes: z.number().int().min(20).max(2_000).default(300) }),
  z.object({ action: z.literal('eval'), js: z.string().trim().min(1).max(20_000) }),
  z.object({
    action: z.literal('wait'),
    selector: z.string().trim().min(1).max(2_000).optional(),
    ref: z.string().regex(/^e[1-9][0-9]*$/u).optional(),
    state: z.enum(['attached', 'detached', 'visible', 'hidden']).default('visible'),
    timeoutMs: z.number().int().min(100).max(30_000).default(5_000)
  }),
  z.object({
    action: z.literal('scroll'),
    selector: z.string().trim().min(1).max(2_000).optional(),
    ref: z.string().regex(/^e[1-9][0-9]*$/u).optional(),
    deltaX: z.number().int().min(-100_000).max(100_000).default(0),
    deltaY: z.number().int().min(-100_000).max(100_000).default(600)
  }),
  z.object({ action: z.literal('click'), selector: z.string().trim().min(1).max(2_000).optional(), ref: z.string().regex(/^e[1-9][0-9]*$/u).optional() }),
  z.object({ action: z.literal('hover'), selector: z.string().trim().min(1).max(2_000).optional(), ref: z.string().regex(/^e[1-9][0-9]*$/u).optional() }),
  z.object({ action: z.literal('type'), selector: z.string().trim().min(1).max(2_000).optional(), ref: z.string().regex(/^e[1-9][0-9]*$/u).optional(), text: z.string().max(100_000), submit: z.boolean().default(false) }),
  z.object({
    action: z.literal('press'),
    selector: z.string().trim().min(1).max(2_000).optional(),
    ref: z.string().regex(/^e[1-9][0-9]*$/u).optional(),
    key: z.union([
      z.enum(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Space']),
      z.string().length(1)
    ])
  }),
  z.object({
    action: z.literal('select'),
    selector: z.string().trim().min(1).max(2_000).optional(),
    ref: z.string().regex(/^e[1-9][0-9]*$/u).optional(),
    values: z.array(z.string().max(1_000)).min(1).max(20)
  }),
  z.object({
    action: z.literal('upload'),
    selector: z.string().trim().min(1).max(2_000).optional(),
    ref: z.string().regex(/^e[1-9][0-9]*$/u).optional(),
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
export const ApprovalInputSchema = z.object({ requestId: z.string(), allow: z.boolean() });
export const WorkflowRunActionInputSchema = z.object({
  sessionId: z.string().min(1),
  workflowId: z.string().min(1)
});
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
  apiKey: z.string().trim().min(1).optional()
});

export const ListModelsInputSchema = z.object({
  protocol: z.literal('openai_chat_completions'),
  baseUrl: z.string().url(),
  apiKey: z.string().trim().min(1).optional()
});

export const SaveExtensionSettingsInputSchema = ExtensionSettingsSchema;

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

export type BrowserDockTab = {
  pageId: number;
  title: string;
  url: string;
  active: boolean;
};

export type BrowserDockState = {
  sessionId: string;
  pages: BrowserDockTab[];
  canGoBack: boolean;
  canGoForward: boolean;
};

export type DesktopApi = {
  listSessions(): Promise<SessionMeta[]>;
  createSession(input: z.input<typeof CreateSessionInputSchema>): Promise<SessionMeta | null>;
  renameSession(input: z.input<typeof RenameSessionInputSchema>): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  loadMessages(sessionId: string): Promise<Message[]>;
  getWorkspaceChanges(sessionId: string): Promise<WorkspaceChanges>;
  startTurn(input: z.input<typeof StartTurnInputSchema>): Promise<void>;
  cancelTurn(sessionId: string): Promise<void>;
  listWorkflowRuns(sessionId: string): Promise<WorkflowRunSnapshot[]>;
  cancelWorkflow(input: z.input<typeof WorkflowRunActionInputSchema>): Promise<void>;
  resumeWorkflow(input: z.input<typeof WorkflowRunActionInputSchema>): Promise<void>;
  resolveApproval(input: z.input<typeof ApprovalInputSchema>): Promise<void>;
  chooseDirectory(): Promise<string | null>;
  chooseImages(): Promise<ImageContentBlock[]>;
  getSettings(): Promise<ProviderSettings>;
  listModels(input: z.input<typeof ListModelsInputSchema>): Promise<string[]>;
  saveSettings(input: z.input<typeof SaveSettingsInputSchema>): Promise<ProviderSettings>;
  getExtensionStatus(input?: z.input<typeof GetExtensionStatusInputSchema>): Promise<ExtensionStatus>;
  getSkillDetail(input: z.input<typeof SkillPathInputSchema>): Promise<SkillDetail>;
  createSkill(input: z.input<typeof CreateSkillInputSchema>): Promise<SkillOperationResult>;
  updateSkill(input: z.input<typeof UpdateSkillInputSchema>): Promise<SkillOperationResult>;
  importSkill(input?: z.input<typeof ImportSkillInputSchema>): Promise<SkillOperationResult>;
  exportSkill(input: z.input<typeof SkillPathInputSchema>): Promise<SkillOperationResult>;
  trashSkill(input: z.input<typeof SkillPathInputSchema>): Promise<SkillOperationResult>;
  saveExtensionSettings(input: z.input<typeof SaveExtensionSettingsInputSchema>): Promise<ExtensionSettings>;
  probeChromeBrowser(port?: number): Promise<{ ok: true; browser: string } | { ok: false; error: string }>;
  setBrowserDockLayout(input: z.input<typeof BrowserDockLayoutSchema>): Promise<void>;
  browserDockAction(input: z.input<typeof BrowserDockActionSchema>): Promise<void>;
  resolveBrowserSecret(input: { requestId: string; value?: string }): Promise<void>;
  connectMcpOAuth(input: z.input<typeof McpServerIdInputSchema>): Promise<void>;
  disconnectMcpOAuth(input: z.input<typeof McpServerIdInputSchema>): Promise<void>;
  reconnectMcp(input: z.input<typeof McpServerIdInputSchema>): Promise<void>;
  onAgentEvent(listener: (event: AgentEvent) => void): () => void;
  onOrchestrationEvent(listener: (event: OrchestrationEvent) => void): () => void;
  onSessionsChanged(listener: () => void): () => void;
  onExtensionsChanged(listener: () => void): () => void;
  onBrowserSecretRequest(listener: (request: { requestId: string; name: string; description?: string }) => void): () => void;
  onBrowserDockState(listener: (state: BrowserDockState | null) => void): () => void;
};

export type WorkerCommand =
  | { type: 'turn.start'; payload: z.input<typeof StartTurnInputSchema> }
  | { type: 'turn.cancel'; sessionId: string }
  | { type: 'session.stop'; sessionId: string }
  | { type: 'workflow.cancel'; sessionId: string; workflowId: string }
  | { type: 'workflow.resume'; requestId: string; sessionId: string; workflowId: string }
  | { type: 'approval.resolve'; requestId: string; allow: boolean }
  | { type: 'config.update'; settings: ProviderSettings; apiKeys: Record<string, string>; mcpOAuthCredentials: Record<string, unknown> }
  | { type: 'mcp.oauth.start'; requestId: string; serverId: string; redirectUrl: string; state: string }
  | { type: 'mcp.oauth.callback'; requestId: string; serverId: string; callbackParams: string }
  | { type: 'mcp.oauth.disconnect'; requestId: string; serverId: string }
  | { type: 'mcp.reconnect'; requestId: string; serverId: string }
  | { type: 'browser.result'; requestId: string; result?: ToolResult; error?: string };

export type WorkerMessage =
  | { type: 'ready' }
  | { type: 'agent.event'; event: AgentEvent }
  | { type: 'orchestration.event'; event: OrchestrationEvent }
  | { type: 'workflow.action.result'; requestId: string; ok: boolean; error?: string }
  | { type: 'sessions.changed' }
  | { type: 'extensions.status'; status: ExtensionStatus }
  | { type: 'mcp.oauth.authorization'; requestId: string; url: string }
  | { type: 'mcp.oauth.credentials'; serverId: string; credentials: unknown }
  | { type: 'mcp.oauth.result'; requestId: string; ok: boolean; error?: string }
  | { type: 'browser.request'; requestId: string; sessionId: string; action: BrowserAction; approved: boolean }
  | { type: 'worker.error'; message: string };

export const IPC = {
  listSessions: 'sessions:list',
  createSession: 'sessions:create',
  renameSession: 'sessions:rename',
  deleteSession: 'sessions:delete',
  loadMessages: 'sessions:messages',
  getWorkspaceChanges: 'workspace:changes',
  startTurn: 'agent:start',
  cancelTurn: 'agent:cancel',
  listWorkflowRuns: 'orchestration:workflow-list',
  cancelWorkflow: 'orchestration:workflow-cancel',
  resumeWorkflow: 'orchestration:workflow-resume',
  resolveApproval: 'agent:approval',
  chooseDirectory: 'system:choose-directory',
  chooseImages: 'system:choose-images',
  getSettings: 'settings:get',
  listModels: 'models:list',
  saveSettings: 'settings:save',
  getExtensionStatus: 'extensions:status',
  getSkillDetail: 'extensions:skill-detail',
  createSkill: 'extensions:skill-create',
  updateSkill: 'extensions:skill-update',
  importSkill: 'extensions:skill-import',
  exportSkill: 'extensions:skill-export',
  trashSkill: 'extensions:skill-trash',
  saveExtensionSettings: 'extensions:save',
  probeChromeBrowser: 'browser:chrome-probe',
  browserDockLayout: 'browser:dock-layout',
  browserDockAction: 'browser:dock-action',
  browserDockState: 'browser:dock-state',
  browserSecretRequest: 'browser:secret-request',
  browserSecretResolve: 'browser:secret-resolve',
  connectMcpOAuth: 'extensions:mcp-oauth-connect',
  disconnectMcpOAuth: 'extensions:mcp-oauth-disconnect',
  reconnectMcp: 'extensions:mcp-reconnect',
  agentEvent: 'agent:event',
  orchestrationEvent: 'orchestration:event',
  sessionsChanged: 'sessions:changed',
  extensionsChanged: 'extensions:changed'
} as const;
