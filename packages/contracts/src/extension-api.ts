import { z } from 'zod';
import type { HookEventName, HookHandler } from './hooks.js';
import type { ModelProvider, ProviderCapabilities } from './model.js';
import type { JsonValue } from './execution-scope.js';
import type { LaneInfo, RunResult, RuntimeEventEnvelope, SessionInfo } from './runtime.js';
import type { Tool } from './tools.js';

export interface Disposable {
  dispose(): void | Promise<void>;
}

export const ExtensionCapabilitySchema = z.enum([
  'tool', 'hook', 'context', 'provider', 'agent_profile', 'workflow_step', 'memory'
]);
export type ExtensionCapability = z.infer<typeof ExtensionCapabilitySchema>;

export const ExtensionPermissionSchema = z.enum([
  'filesystem.read', 'filesystem.write', 'process.execute', 'network', 'credentials.read',
  'browser.control', 'memory.read', 'memory.write', 'runtime.observe'
]);
export type ExtensionPermission = z.infer<typeof ExtensionPermissionSchema>;

const ExtensionIdSchema = z.string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u);

export const ExtensionManifestSchema = z.object({
  id: ExtensionIdSchema,
  name: z.string().trim().min(1).max(120),
  version: z.string().trim().min(1).max(64),
  apiVersion: z.string().trim().min(1).max(64),
  capabilities: z.array(ExtensionCapabilitySchema).max(20),
  permissions: z.array(ExtensionPermissionSchema).max(50).optional(),
  compatibility: z.object({
    jojo: z.string().trim().min(1).max(128).optional(),
    platforms: z.array(z.string().trim().min(1).max(64)).max(20).optional()
  }).strict().optional()
}).strict();
/** Preview: loading third-party code is intentionally outside the stable v1 ABI. */
export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>;

export const ContributionOwnerSchema = z.object({
  id: ExtensionIdSchema,
  version: z.string().trim().min(1).max(64),
  source: z.enum(['builtin', 'external'])
}).strict();
export type ContributionOwner = z.infer<typeof ContributionOwnerSchema>;

export type ExtensionIdentity = ContributionOwner & {
  name?: string;
  apiVersion?: string;
};

export type ToolContribution = {
  /** Local contribution id. External tools are exposed as `<extension-id>:<id>`. */
  id: string;
  tool: Tool;
};

export type RegisterExtensionHookOptions = {
  id?: string;
  matcher?: string | RegExp;
  async?: boolean;
  canApprove?: boolean;
  onError?: 'continue' | 'block';
};

export type ContextBlock = {
  id: string;
  kind: 'instruction' | 'memory' | 'resource' | 'environment';
  content: string;
  priority: number;
  source: string;
  cachePolicy?: 'stable' | 'session' | 'turn';
};

export type ContextContributionRequest = {
  sessionId: string;
  laneId: string;
  runId: string;
  workingDirectory: string;
  userInput?: string;
  signal: AbortSignal;
};

export type ContextContribution = { blocks: ContextBlock[] };

export interface ContextContributor {
  id: string;
  priority?: number;
  contribute(request: ContextContributionRequest): Promise<ContextContribution>;
}

/** Preview provider factory. The provider runtime remains owned by `packages/providers`. */
export type ProviderContribution = {
  id: string;
  capabilities: ProviderCapabilities;
  create(config: JsonValue): ModelProvider | Promise<ModelProvider>;
};

/** Preview profile shape. Orchestration retains policy, isolation, and scheduling ownership. */
export type AgentProfileContribution = {
  id: string;
  description: string;
  systemPrompt: string;
  readOnly: boolean;
  allowedTools?: string[];
  deniedTools?: string[];
  model?: string;
  maxIterations?: number;
  timeoutMs?: number;
  outputSchema?: Record<string, unknown>;
};

/** Preview executor ABI. DAG semantics remain owned by orchestration. */
export type WorkflowStepContribution = {
  id: string;
  execute(input: JsonValue, context: { signal: AbortSignal }): Promise<JsonValue>;
};

/** Preview adapter ABI. Stable memory access should currently use tools/context contributions. */
export type MemoryAdapterContribution = {
  id: string;
  recall(query: string, context: { sessionId: string; signal: AbortSignal }): Promise<ContextBlock[]>;
};

export interface ExtensionRuntimeView {
  getSessionInfo(sessionId: string): Promise<Readonly<SessionInfo> | undefined>;
  getLaneInfo(sessionId: string, laneId: string): Promise<Readonly<LaneInfo> | undefined>;
  getRunSnapshot(runId: string): Promise<Readonly<RunResult> | undefined>;
  subscribe(listener: (event: Readonly<RuntimeEventEnvelope>) => void): Disposable;
}

export interface ExtensionStorage {
  get(key: string): Promise<JsonValue | undefined>;
  set(key: string, value: JsonValue): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

export interface ExtensionAPI {
  readonly extension: ExtensionIdentity;
  readonly runtime: ExtensionRuntimeView;
  readonly storage: ExtensionStorage;

  registerTool(contribution: ToolContribution): Disposable;
  registerHook<E extends HookEventName>(
    event: E,
    handler: HookHandler<E>,
    options?: RegisterExtensionHookOptions
  ): Disposable;
  registerContextContributor(contribution: ContextContributor): Disposable;

  /** Preview. */
  registerProvider(contribution: ProviderContribution): Disposable;
  /** Preview. */
  registerAgentProfile(contribution: AgentProfileContribution): Disposable;
  /** Preview. */
  registerWorkflowStep(contribution: WorkflowStepContribution): Disposable;
  /** Preview. */
  registerMemoryAdapter(contribution: MemoryAdapterContribution): Disposable;
}
