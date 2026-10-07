import { executionFingerprint } from '@desktop-agent/agent-runtime';
import { LocalAttachmentAccessResolver } from '@desktop-agent/attachment-access/local';
import { BrowserRecordingRegistry, FileBrowserRecordingTrustStore } from '@desktop-agent/browser-automation';
import { createFeishuAdapterFactory, createTelegramAdapterFactory } from '@desktop-agent/channel-adapters';
import { ChannelAdapterRegistry, type ChannelBinding, type ChannelInstance } from '@desktop-agent/channel-core';
import {
  ChannelPermissionGate,
  ChannelRuntimeCapability,
  ChannelScheduleDeliveryService,
  CompositeScheduleDeliveryService,
  DefaultChannelManager,
  SqliteChannelStore,
  type ChannelAgentBridge
} from '@desktop-agent/channel-runtime';
import type { SessionMeta } from '@desktop-agent/contracts';
import {
  CandidateExtractionResultSchema,
  DEFAULT_BROWSER_SETTINGS, isPlaceholderSessionTitle, resolveModelForRun, serializedIpcBytes, sessionTitleFromPrompt, WorkerMessageSchema, WorkflowDefinitionSchema, type AgentEvent, type ApprovalRequest, type ChannelSettingsSnapshot, type DesktopChannelMutation,
  type HookRuntime,
  type Message,
  type ModelSelection, type OrchestrationEvent, type ProviderSettings, type SkillStatus, type ToolCall, type WorkerMessage, type WorkflowDefinition
} from '@desktop-agent/contracts';
import type { ApplicationContext } from '@desktop-agent/contracts/application';
import {
  createSkillTool,
  discoverSkills,
  ExtensionPermissionGate,
  McpManager,
  userSkillDirectories,
  type McpOAuthCredentials,
  type SkillDirectory
} from '@desktop-agent/extensions';
import { FileHookTrustStore, loadHookRuntime } from '@desktop-agent/hooks';
import {
  createMemoryTools,
  createProjectIdentity,
  DurableMemoryRuntime,
  MarkdownMemoryStore,
  MemoryCandidateService,
  MemoryIndex,
  MemoryPermissionGate,
  MemoryService,
  SemanticMemoryService,
  type CandidateLifecycleEvent,
  type SemanticLifecycleEvent
} from '@desktop-agent/memory';
import {
  AgentExecutionScheduler,
  createBuiltinAgentProfileRegistry,
  createBuiltinSavedWorkflowRegistry,
  createLeafAgentRunnerAdapter,
  createSubAgentTools,
  createTeamMemberTools,
  createTeamTools,
  createWorkflowTools,
  IsolationManager,
  OrchestrationPermissionGate,
  ProviderSemaphore,
  reloadAgentProfiles,
  reloadSavedWorkflows,
  ResourceGroupLimiter,
  SubAgentManager,
  TeamManager,
  WorkflowEngine,
  WorkflowManager
} from '@desktop-agent/orchestration';
import {
  BackgroundAgentPermissionPolicyStore,
  DefaultPermissionRequestNormalizer,
  GovernanceRuntimePermissionGate,
  MemoryPermissionGrantStore,
  PermissionGovernanceEngine
} from '@desktop-agent/permission-governance';
import { createProvider, OpenAICompatibleEmbeddingProvider } from '@desktop-agent/providers';
import { createProductRuntime, RuntimeEnvironmentRegistry } from '@desktop-agent/runtime-composition';
import type {
  AgentScheduleTarget,
  CreateScheduleInput,
  ScheduleDispatchRequest,
  ScheduleTarget
} from '@desktop-agent/scheduler';
import { ConversationScheduleDeliveryService } from '@desktop-agent/scheduler';
import {
  JsonlWorkflowStore,
  SqliteHookInvocationStore,
  SqliteMcpTrustStore,
  SqliteMemoryCandidateStore,
  SqlitePermissionGovernanceStore,
  SqliteSemanticMemoryBackend,
  SqliteServerStateStore,
  SqliteTeamStore
} from '@desktop-agent/storage';
import { SqliteAgentRuntimeStore } from '@desktop-agent/storage/sqlite-runtime-store';
import { createDefaultToolRuntime, redactSensitiveEnvironmentAssignments } from '@desktop-agent/tools-node';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { DesktopSessionMetadataStore } from '../runtime/session-metadata';
import { readRuntimeMessages } from '../runtime/transcript-reader';
import { DesktopApprovalBroker } from './approval-broker';
import { BrowserPermissionGate, BrowserToolBridge } from './browser-tools';
import { DesktopChannelApprovalBridge, type DesktopActiveChannelRun } from './channel-approval';
import { createDesktopTestProvider } from './e2e-provider';
import { bindWorkerIpc } from './ipc-controller';
import { createDesktopOrchestratedAgentRunner, createDesktopWorkflowToolRuntime } from './orchestration-runtime';
import { createDesktopSchedulerRuntime } from './scheduler-runtime';
import { createSessionController } from './session-controller';
import { InteractiveTerminalSecretBroker } from './terminal-secret-broker';
import { createTurnController } from './turn-controller';
import { TurnTaskRegistry } from './turn-task-registry';

export function startWorkerHost(): void {
  type ParentPort = { on(event: 'message', listener: (event: { data: unknown }) => void): void; postMessage(message: WorkerMessage): void };
  const parentPort = (process as typeof process & { parentPort?: ParentPort }).parentPort;
  if (!parentPort) throw new Error('Agent worker must run as an Electron utility process.');

  const configuredDataDirectory = process.env.DESKTOP_AGENT_DATA_DIR;
  if (!configuredDataDirectory) throw new Error('DESKTOP_AGENT_DATA_DIR is required.');
  const dataDirectory: string = configuredDataDirectory;
  const e2eMode = process.env.JOJO_E2E === '1';
  let runtime: { settings: ProviderSettings; apiKeys: Record<string, string> } | null = null;
  let desktopChannelSecrets: Record<string, string> = {};
  const store = new DesktopSessionMetadataStore(path.join(dataDirectory, 'sessions'), path.join(dataDirectory, 'runtime', 'application.sqlite'));
  const agentRuntimeStore = new SqliteAgentRuntimeStore(path.join(dataDirectory, 'runtime', 'agent-runtime.sqlite'));
  const hookInvocationStore = new SqliteHookInvocationStore(path.join(dataDirectory, 'runtime', 'hooks.sqlite'));
  const mcpTrustStore = new SqliteMcpTrustStore(path.join(dataDirectory, 'runtime', 'mcp-trust.sqlite'));
  const permissionGovernanceStore = new SqlitePermissionGovernanceStore(path.join(dataDirectory, 'runtime', 'permissions.sqlite'));
  const teamStore = new SqliteTeamStore(path.join(dataDirectory, 'runtime', 'teams.sqlite'));
  const permissionGrantStore = new MemoryPermissionGrantStore();
  const permissionGovernanceEngine = new PermissionGovernanceEngine({
    policyStore: new BackgroundAgentPermissionPolicyStore(permissionGovernanceStore),
    grantStore: permissionGrantStore
  });
  const hookTrustStore = new FileHookTrustStore(path.join(os.homedir(), '.jojo', 'hooks-trust.json'));
  const memoryRoot = path.join(os.homedir(), '.jojo', 'memory');
  const memoryIndex = new MemoryIndex(path.join(dataDirectory, 'runtime', 'memory.sqlite'));
  const memoryStore = new MarkdownMemoryStore(memoryRoot, memoryIndex);
  const semanticBackend = new SqliteSemanticMemoryBackend(path.join(dataDirectory, 'runtime', 'memory-semantic.sqlite'));
  const emitSemanticEvent = (event: SemanticLifecycleEvent) => {
    parentPort.postMessage({ type: 'agent.event', event: { type: 'memory.semantic', ...event } });
  };
  const semanticMemoryService = new SemanticMemoryService(
    memoryStore,
    semanticBackend,
    ({ providerId, model }) => {
      const config = runtime?.settings.providers.find((provider) => provider.id === providerId);
      if (!config) return undefined;
      const hostname = new URL(config.baseUrl).hostname.toLocaleLowerCase();
      const local = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname === '::1';
      const apiKey = runtime?.apiKeys[providerId];
      if (!apiKey && !local) return undefined;
      return new OpenAICompatibleEmbeddingProvider({ id: providerId, model, baseUrl: config.baseUrl, apiKey: apiKey ?? '' });
    },
    emitSemanticEvent,
    (usage) => {
      if (!usage.sessionId) return;
      void agentRuntimeStore.appendUsage({
        id: crypto.randomUUID(),
        sessionId: usage.sessionId,
        cause: 'memory_embedding',
        providerId: usage.providerId,
        model: usage.model,
        ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
        ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
        createdAt: Date.now()
      }).catch(() => undefined);
    }
  );
  semanticMemoryService.attach();
  const memoryService = new MemoryService(memoryStore, semanticMemoryService);
  const memoryCandidateStore = new SqliteMemoryCandidateStore(path.join(dataDirectory, 'runtime', 'memory-candidates.sqlite'));
  const emitCandidateEvent = (event: CandidateLifecycleEvent) => {
    parentPort.postMessage({ type: 'agent.event', event: { type: 'memory.candidate', ...event } });
  };
  const memoryCandidateService = new MemoryCandidateService(
    memoryStore,
    memoryCandidateStore,
    (input) => extractMemoryCandidates(input),
    emitCandidateEvent
  );
  const memoryRuntime = new DurableMemoryRuntime(memoryStore, undefined, memoryCandidateService, emitCandidateEvent);
  const memoryReady = memoryStore.initialize().catch(() => undefined);
  const controllers = new Map<string, AbortController>();
  const turnTasks = new TurnTaskRegistry();
  const applicationState = new SqliteServerStateStore(path.join(dataDirectory, 'runtime', 'application.sqlite'));
  const approvals = new DesktopApprovalBroker(applicationState);
  const sessionHookRuntimes = new Map<string, HookRuntime>();
  const runtimeEnvironments = new RuntimeEnvironmentRegistry();
  const channelStore = new SqliteChannelStore(path.join(dataDirectory, 'runtime', 'channels.sqlite'));
  const channelRegistry = new ChannelAdapterRegistry();
  channelRegistry.register(createTelegramAdapterFactory());
  channelRegistry.register(createFeishuAdapterFactory());
  const channelRunsBySession = new Map<string, DesktopActiveChannelRun>();
  const desktopChannelAgent: ChannelAgentBridge = {
    async ensureSession(binding) {
      if (binding.routing.sessionId && await getSessionMetadata(binding.routing.sessionId)) return binding.routing.sessionId;
      const workingDirectory = binding.routing.workspaceRoot ?? path.join(dataDirectory, 'workspaces', 'general');
      await mkdir(workingDirectory, { recursive: true });
      const created = await sessionController.service.execute({ action: 'create', title: `Channel · ${binding.id}`, ...(binding.routing.workspaceRoot ? { workingDirectory } : {}) }) as SessionMeta;
      post({ type: 'sessions.changed' });
      return created.id;
    },
    async run(input) {
      const active = { runId: input.runId, bindingId: input.binding.id, senderId: input.event.sender.id };
      channelRunsBySession.set(input.sessionId, active);
      input.onStarted?.(input.runId);
      try {
        await prepareTranscript(input.sessionId, true);
        const before = (await readRuntimeMessages(agentRuntimeStore, input.sessionId)).map((message) => message.id);
        const settings = runtime?.settings;
        const providerId = input.binding.routing.providerId ?? settings?.activeProviderId ?? '';
        await startTurn(
          input.sessionId,
          input.text,
          [],
          providerId,
          input.binding.routing.model ?? settings?.providers.find((provider) => provider.id === providerId)?.model ?? '',
          {
            runId: input.runId,
            actor: { kind: 'channel_user', id: input.principal.id },
            trigger: { kind: 'channel_message', id: input.event.id },
            channel: {
              bindingId: input.binding.id,
              instanceId: input.binding.instanceId,
              conversationId: input.event.conversation.id,
              ...(input.event.conversation.threadId ? { threadId: input.event.conversation.threadId } : {}),
              senderId: input.event.sender.id,
              inboundMessageId: input.event.message?.id ?? input.event.id
            }
          }
        );
        const messages = await readRuntimeMessages(agentRuntimeStore, input.sessionId);
        const fresh = messages.filter((message) => !before.includes(message.id) && message.role === 'assistant');
        const finalText = fresh.flatMap((message) => message.content.flatMap((block) => block.type === 'text' ? [block.text] : [])).join('\n\n');
        return {
          sessionId: input.sessionId,
          runId: input.runId,
          status: finalText ? 'completed' : 'failed',
          ...(finalText ? { finalText } : {})
        };
      } finally {
        if (channelRunsBySession.get(input.sessionId)?.runId === input.runId) channelRunsBySession.delete(input.sessionId);
      }
    }
  };
  const channelManager = new DefaultChannelManager({
    store: channelStore,
    registry: channelRegistry,
    secrets: {
      resolve: async (reference) => {
        const match = /^secret:\/\/env\/([A-Z_][A-Z0-9_]*)$/u.exec(reference);
        const value = match ? desktopChannelSecrets[match[1]!] ?? process.env[match[1]!] : undefined;
        if (!value) throw new Error(`channel_secret_unavailable: ${reference}`);
        return value;
      }
    },
    agent: desktopChannelAgent
  });
  const desktopChannelApproval = new DesktopChannelApprovalBridge({
    channels: channelManager,
    store: channelStore,
    activeRun: (sessionId) => channelRunsBySession.get(sessionId),
    resolve: async (approvalId, allowed) => {
      const app = await desktopApplication;
      const pending = approvals.get(approvalId);
      if (!pending) return false;
      await app.resolveApproval(desktopContext, approvalId, allowed ? 'allow' : 'deny');
      return true;
    }
  });
  channelManager.setInteractionHandler(desktopChannelApproval);
  approvals.subscribe(event => {
    if (event.type === 'approval.required') {
      void desktopChannelApproval.publish(event.approval.request).catch(error => console.warn('Failed to publish Channel approval', error));
    } else {
      void desktopChannelApproval.invalidate(event.approval.id).catch(() => undefined);
    }
  });
  const desktopProduct = createProductRuntime({
    recovery: 'preserve',
    application: { stateStore: applicationState, approvalBroker: approvals },
    beforeRecovery: async (runtime) => {
      const sessionIds = new Set([
        ...(await runtime.listSessions()).map(session => session.id),
        ...(await applicationState.sessions.list()).map(session => session.sessionId)
      ]);
      for (const sessionId of sessionIds) {
        if (await store.isDeleted(sessionId)) {
          agentRuntimeStore.deleteSessionPermanently(sessionId);
          applicationState.deleteSessionPermanently(sessionId);
        }
      }
    },
    runtime: {
      attachmentAccess: new LocalAttachmentAccessResolver(),
      host: { kind: 'desktop' },
      store: agentRuntimeStore,
      providers: runtimeEnvironments.providers,
      tools: runtimeEnvironments.tools,
      permissions: runtimeEnvironments.permissions,
      summarizer: {
        summarize: ({ source }, signal) => utilityCompletion(
          runtime!.settings.utilityModel,
          `Summarize the conversation below for another coding model. Preserve user requirements, decisions, file paths, errors, unresolved work, and tool outcomes. Never invent facts.\n\n${source}`,
          signal,
          1_024
        )
      },
      memory: memoryRuntime,
      hooks: runtimeEnvironments.hooks,
      runContext: runtimeEnvironments.runContext,
      telemetry: runtimeEnvironments.telemetry,
      capabilities: [new ChannelRuntimeCapability(channelManager)]
    }
  });
  const jojoRuntime = desktopProduct.then(product => product.runtime);
  const desktopApplication = desktopProduct.then(product => product.application);
  const sessionController = createSessionController({
    store, ready: desktopApplication, post: message => post(message),
    defaultDirectory: path.join(dataDirectory, 'workspaces', 'general'),
    ensureDirectory: async directory => { await mkdir(directory, { recursive: true }); },
    resolveProject: async directory => (await createProjectIdentity(directory)) ?? undefined,
    readMessages: async sessionId => agentRuntimeStore.readConversationMessages(sessionId),
    stopSession: async sessionId => { await stopSession(sessionId); permissionGrantStore.clearSession(sessionId); },
    deleteRuntimeSession: async sessionId => { agentRuntimeStore.deleteSessionPermanently(sessionId); },
    deleteApplicationSession: async sessionId => { applicationState.deleteSessionPermanently(sessionId); }
  });
  async function getSessionMetadata(sessionId: string): Promise<SessionMeta | null> {
    await desktopApplication;
    return await sessionController.service.execute({ action: 'get', sessionId }) as SessionMeta | null;
  }

  const desktopContext: ApplicationContext = {
    requestId: 'desktop-worker',
    principal: { id: 'desktop-local', type: 'local', scopes: [] }
  };
  let skillStatuses: SkillStatus[] = [];
  let extensionReady: Promise<void> = Promise.resolve();
  let mcpConfigSignature = '';
  let resolveRuntimeConfigReady: (() => void) | undefined;
  const runtimeConfigReady = new Promise<void>((resolve) => { resolveRuntimeConfigReady = resolve; });

  function redactLegacyTerminalOutput(messages: Message[]): Message[] {
    return messages.map((message) => ({
      ...message,
      content: message.content.map((block) => block.type === 'tool_result'
        ? {
          ...block,
          result: {
            ...block.result,
            content: redactSensitiveEnvironmentAssignments(block.result.content)
          }
        }
        : block)
    }));
  }

  function loadedSkillIdsFromHistory(messages: Message[]): Set<string> {
    const successfulCallIds = new Set(messages.flatMap((message) => message.content.flatMap((block) =>
      block.type === 'tool_result' && block.result.ok ? [block.result.callId] : []
    )));
    return new Set(messages.flatMap((message) => message.content.flatMap((block) => {
      if (block.type !== 'tool_call' || block.call.name !== 'load_skill' || !successfulCallIds.has(block.call.id)) return [];
      const input = block.call.input;
      if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
      const skillId = (input as Record<string, unknown>).skillId;
      return typeof skillId === 'string' ? [skillId] : [];
    })));
  }

  const post = (message: WorkerMessage) => {
    const parsed = WorkerMessageSchema.safeParse(message);
    if (!parsed.success) {
      console.warn('IPC protocol violation', {
        direction: 'worker_to_main',
        messageType: message.type,
        issuePaths: parsed.error.issues.slice(0, 5).map((issue) => issue.path.map(String).join('.')),
        serializedSize: serializedIpcBytes(message)
      });
      return;
    }
    parentPort.postMessage(parsed.data);
  };
  const orchestrationListeners = new Set<(event: OrchestrationEvent) => void>();
  const emitOrchestrationEvent = (event: OrchestrationEvent): void => {
    post({ type: 'orchestration.event', event });
    for (const listener of orchestrationListeners) {
      try { listener(event); } catch { /* Observers are isolated. */ }
    }
  };
  const subscribeOrchestration = (listener: (event: OrchestrationEvent) => void): (() => void) => {
    orchestrationListeners.add(listener);
    return () => orchestrationListeners.delete(listener);
  };
  const terminalSecretBroker = new InteractiveTerminalSecretBroker((request) => {
    post({ type: 'terminal.secret.request', ...request });
  });
  const executionScheduler = new AgentExecutionScheduler(4);
  const resourceGroups = new ResourceGroupLimiter();
  const providerSemaphore = new ProviderSemaphore();
  const profileRegistry = createBuiltinAgentProfileRegistry();
  const userAgentProfileDirectory = path.join(os.homedir(), '.jojo', 'agents');
  const savedWorkflowRegistry = createBuiltinSavedWorkflowRegistry();
  const userWorkflowDirectory = path.join(os.homedir(), '.jojo', 'workflows');
  const isolationManager = new IsolationManager({ worktreeRoot: path.join(dataDirectory, 'worktrees') });
  const orchestratedAgentRunner = createDesktopOrchestratedAgentRunner({
    resolveProvider: (providerId) => {
      const config = runtime?.settings.providers.find((provider) => provider.id === providerId);
      const apiKey = runtime?.apiKeys[providerId];
      return config && apiKey ? { config, apiKey } : undefined;
    },
    trashDirectory: path.join(dataDirectory, 'trash'),
    secretBroker: terminalSecretBroker,
    profileRegistry,
    runtimeStore: agentRuntimeStore,
    memoryRuntime,
    runtimeService: { runtime: jojoRuntime, environments: runtimeEnvironments },
    application: desktopApplication,
    governance: {
      engine: permissionGovernanceEngine,
      audit: permissionGovernanceStore
    },
    resolveAdditionalTools: async (request) => {
      if (request.actor.kind !== 'team_member') return [];
      const actor = request.actor;
      const team = await teamManager.get(actor.teamId);
      const member = team?.members.find((candidate) => candidate.id === actor.memberId);
      if (!team || !member) return [];
      const tools = createTeamMemberTools(teamManager, {
        teamId: team.id,
        memberId: member.id,
        ...(actor.taskId ? { taskId: actor.taskId } : {})
      });
      if (member.spawn?.enabled) {
        tools.push(...createSubAgentTools(subAgentManager, {
          providerId: request.providerId,
          model: request.model,
          spawnContext: {
            parent: { actor: 'team_member', actorId: member.id, teamId: team.id, depth: 0 },
            owner: { kind: 'team_member', id: member.id, teamId: team.id },
            ...(member.spawn.profiles ? { allowedProfiles: member.spawn.profiles } : {}),
            ...(member.spawn.maxActive !== undefined ? { maxActive: member.spawn.maxActive } : {})
          }
        }));
      }
      return tools;
    },
    resolveHooks: async ({ sessionId, workingDirectory, signal, onEvent }) => sessionHookRuntimes.get(sessionId)
      ?? (await loadHookRuntime({ workingDirectory, invocationStore: hookInvocationStore, trustStore: hookTrustStore, signal, emit: onEvent })).runtime
  });
  const leafAgentRunner = createLeafAgentRunnerAdapter(orchestratedAgentRunner);
  const subAgentManager = new SubAgentManager(
    leafAgentRunner,
    executionScheduler,
    emitOrchestrationEvent,
    {
      profileRegistry,
      isolation: isolationManager,
      resourceGroups,
      providers: providerSemaphore,
      resolveHooks: async ({ sessionId, workingDirectory, signal }) => sessionHookRuntimes.get(sessionId)
        ?? (await loadHookRuntime({
          workingDirectory,
          invocationStore: hookInvocationStore,
          trustStore: hookTrustStore,
          signal,
          emit: (event) => post({ type: 'agent.event', event })
        })).runtime
    }
  );
  const teamManager = new TeamManager(
    teamStore,
    orchestratedAgentRunner,
    executionScheduler,
    emitOrchestrationEvent,
    {
      profileRegistry,
      isolation: isolationManager,
      resourceGroups,
      providers: providerSemaphore,
      subAgents: subAgentManager
    }
  );
  const teamReady = teamManager.initialize();
  void teamReady.catch((error) => { console.warn('Team recovery failed', error); });
  const browserSettings = () => runtime?.settings.extensions.browser ?? { ...DEFAULT_BROWSER_SETTINGS, enabled: false };
  const browserBridge = new BrowserToolBridge(post, browserSettings);
  const browserRecordingRegistry = new BrowserRecordingRegistry({
    userDirectory: path.join(os.homedir(), '.jojo', 'browser-recordings'),
    legacyUserDirectory: path.join(dataDirectory, 'browser-recordings'),
    trustStore: new FileBrowserRecordingTrustStore(path.join(os.homedir(), '.jojo', 'browser-recording-trust.json'))
  });

  async function describeWorkflowRecordingPlan(call: ToolCall, workingDirectory: string): Promise<string | undefined> {
    if (!call.input || typeof call.input !== 'object' || Array.isArray(call.input)) return undefined;
    const input = call.input as { name?: unknown; definition?: unknown };
    let definition: WorkflowDefinition;
    if (typeof input.name === 'string') {
      definition = savedWorkflowRegistry.get(input.name, workingDirectory).definition;
    } else {
      let raw = input.definition;
      if (typeof raw === 'string') raw = parseYaml(raw, { maxAliasCount: 0 });
      const parsed = WorkflowDefinitionSchema.safeParse(raw);
      if (!parsed.success) return undefined;
      definition = parsed.data;
    }
    const recordingIds = new Set<string>();
    const visitedWorkflows = new Set<string>();
    const collect = (current: WorkflowDefinition, depth: number) => {
      if (depth > 8) return;
      for (const step of current.steps) {
        if (step.type === 'recording') recordingIds.add(step.recording);
        if (step.type === 'workflow' && !visitedWorkflows.has(step.name)) {
          visitedWorkflows.add(step.name);
          collect(savedWorkflowRegistry.get(step.name, workingDirectory).definition, depth + 1);
        }
      }
    };
    collect(definition, 0);
    if (recordingIds.size === 0) return undefined;
    const lines = await Promise.all([...recordingIds].map(async (recordingId) => {
      const entry = await browserRecordingRegistry.get(recordingId, workingDirectory);
      return `- ${recordingId} [${entry.source}${entry.source === 'project' ? `/${entry.trust}` : ''}] domains=${entry.effectSummary.domains.join(',') || 'none'} effects=${entry.effectSummary.effects.join(',') || 'none'}`;
    }));
    return `Automation plan:\n${lines.join('\n')}`;
  }
  const workflowManager = new WorkflowManager(
    new WorkflowEngine(leafAgentRunner, executionScheduler, {
      profileRegistry,
      isolation: isolationManager,
      toolRuntime: createDesktopWorkflowToolRuntime({
        trashDirectory: path.join(dataDirectory, 'trash'),
        secretBroker: terminalSecretBroker,
        governance: {
          engine: permissionGovernanceEngine,
          audit: permissionGovernanceStore
        }
      }),
      savedWorkflows: savedWorkflowRegistry,
      resourceGroups,
      providers: providerSemaphore,
      recordingRuntime: {
        async execute(invocation) {
          const replayTool = browserBridge.tools().find((tool) => tool.definition.name === 'browser_replay');
          if (!replayTool) {
            return { ok: false, code: 'browser_replay_failed', content: 'Browser tools are disabled in Settings.' };
          }
          try {
            const result = await replayTool.execute({
              recordingId: invocation.recordingId,
              params: invocation.params,
              maxRetries: invocation.maxRetries,
              retryDelayMs: invocation.retryDelayMs,
              ...(invocation.resume ? { resumeRunId: invocation.runId } : { runId: invocation.runId })
            }, {
              sessionId: invocation.sessionId,
              workingDirectory: invocation.workingDirectory,
              signal: invocation.signal,
              approved: true,
              onProgress: invocation.onProgress
            });
            return {
              ok: result.ok,
              content: result.content,
              ...(result.code ? { code: result.code } : {}),
              ...(result.structuredResult === undefined ? {} : { structuredResult: result.structuredResult })
            };
          } catch (error) {
            if (invocation.signal.aborted) throw error;
            const content = error instanceof Error ? error.message : String(error);
            return {
              ok: false,
              code: /stopped after dispatching|confirmUnsafeResume|external effect/iu.test(content)
                ? 'browser_resume_unsafe'
                : 'browser_replay_failed',
              content
            };
          }
        }
      }
    }),
    emitOrchestrationEvent,
    {
      persistence: new JsonlWorkflowStore(path.join(dataDirectory, 'workflows', 'runs')),
      savedWorkflows: savedWorkflowRegistry,
      memorySnapshotExists: async (snapshotId) => Boolean(await agentRuntimeStore.getEntry(`memsnap:${snapshotId}`))
    }
  );
  const mcpManager = new McpManager((mcpServers) => {
    post({ type: 'extensions.status', status: { mcpServers, skills: skillStatuses } });
  }, undefined, {
    onAuthorization: (requestId, url) => post({ type: 'mcp.oauth.authorization', requestId, url }),
    onCredentials: (serverId, credentials) => post({ type: 'mcp.oauth.credentials', serverId, credentials })
  }, { trustStore: mcpTrustStore, enforceStdioSandbox: true, secretBroker: terminalSecretBroker });

  function globalSkillDirectories(settings: ProviderSettings): SkillDirectory[] {
    return [
      { path: path.join(dataDirectory, 'skills'), origin: 'user' },
      ...userSkillDirectories().map((directory) => ({ path: directory, origin: 'user' as const })),
      ...settings.extensions.skills.directories.map((directory) => ({ path: directory, origin: 'custom' as const }))
    ];
  }

  async function reloadOrchestrationAssets(projectRoot?: string): Promise<void> {
    await reloadAgentProfiles(profileRegistry, {
      userDirectory: userAgentProfileDirectory,
      ...(projectRoot ? { projectRoot } : {})
    });
    await reloadSavedWorkflows(savedWorkflowRegistry, {
      userDirectory: userWorkflowDirectory,
      ...(projectRoot ? { projectRoot } : {})
    });
  }

  async function applyRuntimeConfig(
    settings: ProviderSettings,
    apiKeys: Record<string, string>,
    mcpOAuthCredentials: Record<string, unknown>,
    terminalSecrets: Record<string, string>
  ): Promise<void> {
    runtime = { settings, apiKeys };
    // The scheduler may now restore persisted occurrences. Dispatch preparation
    // still awaits the complete extensionReady chain, so resolving here avoids a
    // permanent startup wait when an optional extension later fails to configure.
    resolveRuntimeConfigReady?.();
    resolveRuntimeConfigReady = undefined;
    permissionGovernanceStore.setGlobalMode(settings.permissions.mode);
    terminalSecretBroker.replace(terminalSecrets);
    memoryRuntime.updateSettings(settings.memory);
    memoryService.updateSettings(settings.memory);
    await reloadOrchestrationAssets();
    skillStatuses = (await discoverSkills(
      globalSkillDirectories(settings),
      settings.extensions.skills.disabled
    )).map(({ content: _content, ...status }) => status);
    post({ type: 'extensions.status', status: { mcpServers: mcpManager.getStatuses(), skills: skillStatuses } });
    const nextMcpSignature = JSON.stringify(settings.extensions.mcpServers);
    const shouldReconnect = nextMcpSignature !== mcpConfigSignature
      || mcpManager.getStatuses().some((status) => status.state === 'error');
    if (shouldReconnect) {
      await mcpManager.configure(settings.extensions.mcpServers, mcpOAuthCredentials as Record<string, McpOAuthCredentials>);
      mcpConfigSignature = nextMcpSignature;
    }
  }

  async function utilityCompletion(
    selection: ModelSelection,
    prompt: string,
    signal: AbortSignal,
    maxOutputTokens: number,
    usageContext?: { sessionId: string; operationId?: string; cause: 'memory_candidate' | 'browser_heal' }
  ): Promise<string> {
    if (e2eMode) return prompt.includes('strict JSON') ? '{"candidates":[]}' : 'E2E Session';
    if (!runtime) throw new Error('Provider settings are unavailable.');
    const config = runtime.settings.providers.find((provider) => provider.id === selection.providerId);
    const apiKey = runtime.apiKeys[selection.providerId];
    if (!config || !apiKey) throw new Error('Utility model is not configured.');
    const message: Message = {
      id: crypto.randomUUID(), role: 'user', createdAt: new Date().toISOString(),
      content: [{ type: 'text', text: prompt }]
    };
    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    const startedAt = Date.now();
    for await (const event of createProvider(config, apiKey).stream({
      model: selection.model, messages: [message], tools: [], signal, maxOutputTokens: resolveModelForRun(config, selection.model, { maxOutputTokens }).requestMaxOutputTokens
    })) {
      if (event.type === 'text_delta') text += event.text;
      else if (event.type === 'response_failed') throw new Error(event.message);
      else if (event.type === 'usage') {
        inputTokens += event.inputTokens ?? 0;
        outputTokens += event.outputTokens ?? 0;
        costUsd += event.costUsd ?? 0;
      }
    }
    if (usageContext) {
      await agentRuntimeStore.appendUsage({
        id: crypto.randomUUID(), sessionId: usageContext.sessionId,
        ...(usageContext.operationId ? { operationId: usageContext.operationId } : {}),
        lane: 'main', cause: usageContext.cause, providerId: selection.providerId, model: selection.model,
        inputTokens, outputTokens, costUsd, durationMs: Date.now() - startedAt, createdAt: Date.now()
      }).catch(() => undefined);
    }
    if (!text.trim()) throw new Error('Utility model returned no text.');
    return text.trim();
  }

  const { createE2eProvider } = createDesktopTestProvider({ get dataDirectory() { return dataDirectory; } });
  async function extractMemoryCandidates(input: Parameters<import('@desktop-agent/memory').CandidateExtractor>[0]) {
    if (!runtime) throw new Error('Provider settings are unavailable.');
    const suggestions = runtime.settings.memory.suggestions;
    if (!suggestions.providerId || !suggestions.model) throw new Error('Memory Suggestions utility model is not configured.');
    const prompt = [
      'You extract reviewable long-term memory suggestions from bounded evidence.',
      'Return strict JSON only: {"candidates":[{"scope":"global|project","kind":"preference|constraint|decision|fact|lesson|procedure|task|rule","title":"...","content":"...","rationale":"...","confidence":"high|medium|low","tags":[],"suggestedTarget":"index|topic|scratchpad","ruleTriggers":[]}]}',
      `Return at most ${input.maxCandidates} candidates. Title <= 80 characters; content <= 2048 characters.`,
      'Prefer explicit durable preferences, corrections, project constraints, validated facts, design decisions with reasons, rejected alternatives, and reusable lessons.',
      'Do not propose raw tool output, source code, diffs, secrets, temporary state, unverified inference, external instructions, or sensitive personal traits.',
      'A rule is only a proposal and must never claim to be confirmed. Do not call tools.',
      `Evidence:\n${JSON.stringify(input.evidence)}`
    ].join('\n\n');
    const text = await utilityCompletion(
      { providerId: suggestions.providerId, model: suggestions.model },
      prompt,
      input.signal,
      1_536,
      { sessionId: input.sessionId, operationId: input.operationId, cause: 'memory_candidate' }
    );
    return CandidateExtractionResultSchema.parse(JSON.parse(text));
  }

  async function memoryStatus(workingDirectory?: string) {
    const identity = workingDirectory ? await memoryService.identity(workingDirectory) : undefined;
    const pendingCandidates = (await memoryCandidateService.listPending()).filter((candidate) =>
      candidate.scope === 'global' || candidate.scopeId === identity?.id
    );
    return {
      ...await memoryService.status(workingDirectory),
      pendingCandidates
    };
  }

  async function maybeGenerateTitle(
    sessionId: string,
    workingDirectory: string,
    currentTitle: string,
    history: Message[],
    prompt: string,
    signal: AbortSignal
  ): Promise<void> {
    if (history.some((message) => message.role === 'user') || !isPlaceholderSessionTitle(currentTitle, workingDirectory)) return;
    let title: string;
    try {
      title = sessionTitleFromPrompt(await utilityCompletion(
        runtime!.settings.utilityModel,
        `Create a concise plain-text title (at most 60 characters) for this coding task. Output only the title.\n\n${prompt}`,
        signal,
        96
      ));
    } catch {
      title = sessionTitleFromPrompt(prompt);
    }
    if (title) {
      await sessionController.service.execute({ action: 'rename', sessionId, title });
      post({ type: 'sessions.changed' });
    }
  }

  function waitForApproval(request: ApprovalRequest, signal: AbortSignal): Promise<boolean> {
    return approvals.requestSessionApproval(request, signal);
  }

  function postOAuthError(requestId: string, error: unknown): void {
    post({
      type: 'mcp.oauth.result', requestId, ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }



  const preparingTranscripts = new Map<string, Promise<void>>();
  const stoppingTranscripts = new Set<string>();

  const { prepareTranscript, startTurn, launchTurn, stopSession } = createTurnController({
    get stoppingTranscripts() { return stoppingTranscripts; },
    get preparingTranscripts() { return preparingTranscripts; },
    get agentRuntimeStore() { return agentRuntimeStore; },
    get getSessionMetadata() { return getSessionMetadata; },
    get store() { return store; },
    get desktopApplication() { return desktopApplication; },
    get desktopContext() { return desktopContext; },
    get redactLegacyTerminalOutput() { return redactLegacyTerminalOutput; },
    get extensionReady() { return extensionReady; },
    set extensionReady(value) { extensionReady = value; },
    get teamReady() { return teamReady; },
    get runtime() { return runtime; },
    get jojoRuntime() { return jojoRuntime; },
    get e2eMode() { return e2eMode; },
    get memoryReady() { return memoryReady; },
    get reloadOrchestrationAssets() { return reloadOrchestrationAssets; },
    get loadedSkillIdsFromHistory() { return loadedSkillIdsFromHistory; },
    get controllers() { return controllers; },
    get post() { return post; },
    get hookInvocationStore() { return hookInvocationStore; },
    get hookTrustStore() { return hookTrustStore; },
    get waitForApproval() { return waitForApproval; },
    get sessionHookRuntimes() { return sessionHookRuntimes; },
    get maybeGenerateTitle() { return maybeGenerateTitle; },
    get dataDirectory() { return dataDirectory; },
    get terminalSecretBroker() { return terminalSecretBroker; },
    get globalSkillDirectories() { return globalSkillDirectories; },
    get skillStatuses() { return skillStatuses; },
    set skillStatuses(value) { skillStatuses = value; },
    get mcpManager() { return mcpManager; },
    get subAgentManager() { return subAgentManager; },
    get teamManager() { return teamManager; },
    get workflowManager() { return workflowManager; },
    get memoryService() { return memoryService; },
    get schedulerReady() { return schedulerReady; },
    get browserSettings() { return browserSettings; },
    get browserBridge() { return browserBridge; },
    get memoryRoot() { return memoryRoot; },
    get browserRecordingRegistry() { return browserRecordingRegistry; },
    get describeWorkflowRecordingPlan() { return describeWorkflowRecordingPlan; },
    get permissionGovernanceEngine() { return permissionGovernanceEngine; },
    get permissionGovernanceStore() { return permissionGovernanceStore; },
    get runtimeEnvironments() { return runtimeEnvironments; },
    get createE2eProvider() { return createE2eProvider; },
    get turnTasks() { return turnTasks; },
    get approvals() { return approvals; },
    get memoryRuntime() { return memoryRuntime; }
  });
  function scheduledAgentConfiguration(target: AgentScheduleTarget) {
    if (!runtime) throw new Error('schedule_target_invalid: Model settings are unavailable.');
    const providerConfig = runtime.settings.providers.find((provider) => provider.id === target.providerId);
    if (!providerConfig) throw new Error(`schedule_target_invalid: Provider "${target.providerId}" does not exist.`);
    if (!providerConfig.models.some((item) => item.id === target.model)) {
      throw new Error(`schedule_target_invalid: Model "${target.model}" is not available for ${providerConfig.name}.`);
    }
    const apiKey = e2eMode ? 'e2e-offline-key' : runtime.apiKeys[target.providerId];
    if (!apiKey) throw new Error(`schedule_target_invalid: Configure the ${providerConfig.name} API key first.`);
    return { providerConfig, apiKey };
  }

  function compactScheduleInput(input: object): CreateScheduleInput {
    // IPC is already Zod-validated. The JSON round-trip only removes optional
    // properties materialized as `undefined` by schema inference so they match
    // the scheduler core's exact-optional domain types.
    return JSON.parse(JSON.stringify(input)) as CreateScheduleInput;
  }

  async function validateScheduleTarget(target: ScheduleTarget): Promise<void> {
    if (target.kind === 'workflow') {
      scheduledAgentConfiguration({
        kind: 'agent', sessionId: target.sessionId, input: { content: [{ type: 'text', text: 'workflow' }] },
        providerId: target.providerId, model: target.model
      });
      const session = await getSessionMetadata(target.sessionId);
      if (!session) throw new Error(`schedule_target_not_found: Session ${target.sessionId} does not exist.`);
      if (path.resolve(session.workingDirectory) !== path.resolve(target.workingDirectory)) {
        throw new Error('schedule_target_invalid: Workflow working directory must match its session.');
      }
      await reloadOrchestrationAssets(target.workingDirectory);
      const workflowTarget = target.workflow;
      if (workflowTarget.kind === 'saved') {
        const available = workflowManager.listSaved(target.workingDirectory);
        if (!available.some((workflow) => workflow.name === workflowTarget.name)) {
          throw new Error(`schedule_target_not_found: Saved workflow ${workflowTarget.name} does not exist.`);
        }
      } else {
        WorkflowDefinitionSchema.parse(workflowTarget.definition);
      }
      return;
    }
    if (target.kind === 'team_member') {
      const team = await teamManager.get(target.teamId);
      if (!team) throw new Error(`schedule_target_not_found: Team ${target.teamId} does not exist.`);
      const member = team.members.find((candidate) => candidate.id === target.memberId);
      if (!member) throw new Error(`schedule_target_not_found: Team member ${target.teamId}/${target.memberId} does not exist.`);
      if (member.state === 'disabled') throw new Error(`schedule_target_invalid: Team member ${target.memberId} is disabled.`);
      if (target.providerId || target.model) {
        if (!target.providerId || !target.model) throw new Error('schedule_target_invalid: Team provider and model must be set together.');
        scheduledAgentConfiguration({
          kind: 'agent', sessionId: target.parentSessionId, input: { content: [{ type: 'text', text: target.task }] },
          providerId: target.providerId, model: target.model
        });
      }
      return;
    }
    scheduledAgentConfiguration(target);
    const session = await getSessionMetadata(target.sessionId);
    if (!session) throw new Error(`schedule_target_not_found: Session ${target.sessionId} does not exist.`);
    if (target.lane?.mode === 'main' && target.lane.id) {
      throw new Error('schedule_target_invalid: A main lane target cannot specify a custom lane id.');
    }
  }

  async function prepareScheduledAgent(
    input: ScheduleDispatchRequest<AgentScheduleTarget>,
    laneId: string
  ): Promise<{ dispose(): void }> {
    await extensionReady;
    await teamReady;
    await memoryReady;
    await prepareTranscript(input.target.sessionId, true);
    const { providerConfig, apiKey } = scheduledAgentConfiguration(input.target);
    const session = await getSessionMetadata(input.target.sessionId);
    if (!session) throw new Error(`schedule_target_not_found: Session ${input.target.sessionId} does not exist.`);
    const projectBound = session.projectBound !== false;
    const projectIdentity = projectBound
      ? session.projectIdentity ?? await createProjectIdentity(session.workingDirectory)
      : undefined;
    await reloadOrchestrationAssets(projectBound ? session.workingDirectory : undefined);
    const publicRuntime = await jojoRuntime;
    await publicRuntime.openSession({
      id: session.id,
      executionScope: { kind: 'workspace', workingDirectory: session.workingDirectory },
      ...(projectIdentity ? {
        metadata: { projectIdentity: projectIdentity as unknown as import('@desktop-agent/contracts/runtime').JsonValue }
      } : {})
    });

    const history = await readRuntimeMessages(agentRuntimeStore, session.id);
    const preparationController = new AbortController();
    const emitScheduledAgentEvent = (event: AgentEvent) => {
      // Background runs have their own Scheduler event stream. Only approvals
      // enter the foreground Agent channel so they do not overwrite an active
      // interactive conversation's running state.
      if (event.type === 'approval.required') post({ type: 'agent.event', event });
    };
    const loadedHooks = await loadHookRuntime({
      workingDirectory: session.workingDirectory,
      includeProject: projectBound,
      invocationStore: hookInvocationStore,
      trustStore: hookTrustStore,
      signal: preparationController.signal,
      emit: emitScheduledAgentEvent
    });
    sessionHookRuntimes.set(session.id, loadedHooks.runtime);
    const toolRuntime = createDefaultToolRuntime({
      trashDirectory: path.join(dataDirectory, 'trash'),
      secretBroker: terminalSecretBroker
    });
    const skills = await discoverSkills([
      ...(projectBound ? [
        { path: path.join(session.workingDirectory, '.codex', 'skills'), origin: 'project' as const },
        { path: path.join(session.workingDirectory, '.agents', 'skills'), origin: 'project' as const }
      ] : []),
      ...globalSkillDirectories(runtime!.settings)
    ], runtime!.settings.extensions.skills.disabled);
    const skillTool = createSkillTool(skills, { loadedSkillIds: loadedSkillIdsFromHistory(history) });
    const orchestrationTools = [
      ...createSubAgentTools(subAgentManager, {
        providerId: input.target.providerId,
        model: input.target.model
      }),
      ...createTeamTools(teamManager, {
        providerId: input.target.providerId,
        model: input.target.model
      }),
      ...createWorkflowTools(workflowManager, {
        providerId: input.target.providerId,
        model: input.target.model
      })
    ];
    const memoryTools = runtime!.settings.memory.enabled
      ? createMemoryTools(memoryService).filter((tool) => runtime!.settings.memory.search.enabled || tool.definition.name !== 'memory_search')
      : [];
    const staticTools = [
      ...toolRuntime.tools,
      ...memoryTools,
      ...browserBridge.tools(),
      ...orchestrationTools,
      ...(skillTool ? [skillTool] : [])
    ];
    const legacyPermissionGate = new ChannelPermissionGate(
      new OrchestrationPermissionGate(
        new BrowserPermissionGate(
          new ExtensionPermissionGate(
            new MemoryPermissionGate(toolRuntime.permissionGate, memoryRoot),
            undefined,
            (call) => mcpManager.describeApproval(call),
            (call) => mcpManager.approvalGrantKey(call)
          ),
          browserSettings,
          async (recordingId, workingDirectory) => {
            const entry = await browserRecordingRegistry.get(recordingId, workingDirectory);
            return [
              `Source: ${entry.source}${entry.source === 'project' ? ` (${entry.trust})` : ''}`,
              `Domains: ${entry.effectSummary.domains.join(', ') || 'none'}`,
              `Effects: ${entry.effectSummary.effects.join(', ') || 'none'}`
            ].join('\n');
          }
        ),
        (call, context) => describeWorkflowRecordingPlan(call, context.workingDirectory)
      )
    );
    const permissionGate = new GovernanceRuntimePermissionGate(
      legacyPermissionGate,
      permissionGovernanceEngine,
      new DefaultPermissionRequestNormalizer(),
      permissionGovernanceStore
    );
    const binding = runtimeEnvironments.bind(session.id, laneId, {
      providerConfig,
      provider: e2eMode ? createE2eProvider() : createProvider(providerConfig, apiKey),
      models: providerConfig.models,
      tools: { snapshot: (context) => [...staticTools, ...mcpManager.getTools(context)] },
      permissions: permissionGate,
      hooks: loadedHooks.runtime,
      runContext: { ...(projectIdentity ? { projectIdentity } : {}), instructionBlocks: mcpManager.getInstructionContributions(), executionPolicyFingerprint: executionFingerprint('desktop-scheduler-v1') },
      telemetry: { diagnostic: emitScheduledAgentEvent }
    });
    return {
      dispose: () => {
        binding.dispose();
        preparationController.abort(new DOMException('Schedule run environment released.', 'AbortError'));
      }
    };
  }

  const workflowReady = workflowManager.restore().catch((error) => {
    post({ type: 'worker.error', message: `Workflow restore failed: ${error instanceof Error ? error.message : String(error)}` });
  });
  const channelReady = Promise.all([jojoRuntime, runtimeConfigReady]).then(async () => {
    await channelManager.start();
    return channelManager;
  });

  async function channelSnapshot(): Promise<ChannelSettingsSnapshot> {
    const manager = await channelReady;
    const [instances, bindings, pairings, deliveries, health] = await Promise.all([
      manager.listInstances(),
      manager.listBindings(),
      manager.listPairings(),
      manager.listDeliveries({ limit: 100 }),
      manager.listHealth()
    ]);
    return {
      instances,
      bindings,
      pairings: pairings.map(({ codeHash: _codeHash, ...pairing }) => pairing),
      deliveries: deliveries.map((delivery) => ({
        id: delivery.id,
        instanceId: delivery.instanceId,
        ...(delivery.bindingId ? { bindingId: delivery.bindingId } : {}),
        conversationId: delivery.conversationId,
        ...(delivery.threadId ? { threadId: delivery.threadId } : {}),
        ...(delivery.request.mode ? { mode: delivery.request.mode } : {}),
        status: delivery.status,
        attemptCount: delivery.attemptCount,
        createdAt: delivery.createdAt,
        ...(delivery.deliveredAt ? { deliveredAt: delivery.deliveredAt } : {}),
        ...(delivery.nativeMessageId ? { nativeMessageId: delivery.nativeMessageId } : {}),
        ...(delivery.lastError ? { lastError: delivery.lastError } : {})
      })),
      health
    };
  }

  async function normalizeChannelInstance(
    draft: Extract<DesktopChannelMutation, { action: 'instance.save' }>['instance']
  ): Promise<ChannelInstance> {
    const current = (await channelManager.listInstances()).find((instance) => instance.id === draft.id);
    const now = new Date().toISOString();
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ kind: draft.kind, config: draft.config, secretRefs: draft.secretRefs }))
      .digest('hex');
    return {
      ...draft,
      revision: (current?.revision ?? 0) + 1,
      fingerprint,
      createdAt: current?.createdAt ?? now,
      updatedAt: now
    };
  }

  async function normalizeChannelBinding(
    draft: Extract<DesktopChannelMutation, { action: 'binding.save' }>['binding']
  ): Promise<ChannelBinding> {
    const current = (await channelManager.listBindings()).find((binding) => binding.id === draft.id);
    const now = new Date().toISOString();
    return {
      id: draft.id,
      instanceId: draft.instanceId,
      conversation: {
        id: draft.conversation.id,
        type: draft.conversation.type,
        ...(draft.conversation.threadId ? { threadId: draft.conversation.threadId } : {})
      },
      routing: {
        sessionMode: draft.routing.sessionMode,
        ...(draft.routing.sessionId ? { sessionId: draft.routing.sessionId } : {}),
        ...(draft.routing.workspaceRoot ? { workspaceRoot: draft.routing.workspaceRoot } : {}),
        ...(draft.routing.providerId ? { providerId: draft.routing.providerId } : {}),
        ...(draft.routing.model ? { model: draft.routing.model } : {}),
        ...(draft.routing.instructions ? { instructions: draft.routing.instructions } : {}),
        ...(draft.routing.profile ? { profile: draft.routing.profile } : {})
      },
      policy: {
        enabled: draft.policy.enabled,
        requireMention: draft.policy.requireMention,
        queueMode: draft.policy.queueMode,
        ...(draft.policy.allowedSenders ? { allowedSenders: draft.policy.allowedSenders } : {}),
        allowAttachments: draft.policy.allowAttachments
      },
      revision: (current?.revision ?? 0) + 1,
      createdAt: current?.createdAt ?? now,
      updatedAt: now
    };
  }

  async function mutateChannel(input: DesktopChannelMutation) {
    const manager = await channelReady;
    if (input.action === 'instance.save') {
      await manager.saveInstance(await normalizeChannelInstance(input.instance), input.expectedRevision);
    } else if (input.action === 'instance.delete') {
      await manager.deleteInstance(input.instanceId, input.expectedRevision);
    } else if (input.action === 'binding.save') {
      await manager.saveBinding(await normalizeChannelBinding(input.binding), input.expectedRevision);
    } else if (input.action === 'binding.delete') {
      await manager.deleteBinding(input.bindingId, input.expectedRevision);
    } else if (input.action === 'pairing.approve') {
      await manager.approvePairing(input.pairingId, await normalizeChannelBinding(input.binding));
    } else if (input.action === 'pairing.reject') {
      await manager.rejectPairing(input.pairingId);
    } else {
      return manager.deliver({
        ...(input.bindingId
          ? { bindingId: input.bindingId }
          : { target: { instanceId: input.instanceId, conversationId: input.conversationId!, ...(input.threadId ? { threadId: input.threadId } : {}) } }),
        content: [{ type: 'text', text: input.text }],
        mode: 'system',
        idempotencyKey: `desktop-channel-test:${crypto.randomUUID()}`
      });
    }
    return channelSnapshot();
  }
  const schedulerReady = Promise.all([workflowReady, teamReady, jojoRuntime, runtimeConfigReady, channelReady]).then(
    async ([, , activeRuntime, , activeChannels]) => createDesktopSchedulerRuntime({
      application: await desktopApplication,
      dataDirectory,
      runtime: activeRuntime,
      teamManager,
      workflowManager,
      subscribeOrchestration,
      prepareAgent: prepareScheduledAgent,
      validateTarget: validateScheduleTarget,
      deliveryService: new CompositeScheduleDeliveryService([
        new ConversationScheduleDeliveryService({
          appendMessage: async (sessionId, message) => {
            if (!await getSessionMetadata(sessionId)) {
              throw new Error(`schedule_delivery_target_not_found: Session ${sessionId} does not exist.`);
            }
            await prepareTranscript(sessionId, true);
            agentRuntimeStore.appendConversationMessage(sessionId, message);
            const automation = message.metadata?.automation;
            if (!automation) throw new Error('schedule_delivery_invalid_message: Missing automation metadata.');
            post({
              type: 'conversation.message.created',
              event: {
                sessionId,
                messageId: message.id,
                scheduleId: automation.scheduleId,
                scheduleRunId: automation.scheduleRunId
              }
            });
          }
        }),
        new ChannelScheduleDeliveryService(activeChannels)
      ]),
      emit: (scheduleEvent) => post({ type: 'scheduler.event', event: scheduleEvent })
    })
  );
  void schedulerReady
    .catch((error) => post({
      type: 'worker.error',
      message: `Scheduler initialization failed: ${error instanceof Error ? error.message : String(error)}`
    }))
    .finally(() => post({ type: 'ready' }));

  bindWorkerIpc({
    parentPort, sessionController,
    get desktopChannelSecrets() { return desktopChannelSecrets; },
    set desktopChannelSecrets(value) { desktopChannelSecrets = value; },
    get extensionReady() { return extensionReady; },
    set extensionReady(value) { extensionReady = value; }, applyRuntimeConfig, post, launchTurn, controllers, terminalSecretBroker, approvals, prepareTranscript, stopSession, permissionGrantStore, workflowManager, reloadOrchestrationAssets, desktopApplication, desktopContext, mcpManager, postOAuthError,
    get runtime() { return runtime; }, agentRuntimeStore, utilityCompletion, browserBridge, sessionHookRuntimes, teamReady, teamManager, schedulerReady, compactScheduleInput, channelSnapshot, mutateChannel, memoryReady, memoryStatus, memoryService, memoryCandidateService
  });
  process.once('SIGTERM', () => {
    void Promise.allSettled([
      schedulerReady.then((activeScheduler) => activeScheduler.close()),
      channelReady.then((activeChannels) => activeChannels.stop()),
      mcpManager.close(),
      semanticMemoryService.idle(),
      desktopProduct.then((product) => product.close())
    ]).finally(() => {
      semanticBackend.close();
      memoryCandidateStore.close();
      memoryIndex.close();
      hookInvocationStore.close();
      mcpTrustStore.close();
      agentRuntimeStore.close();
      process.exit(0);
    });
  });

}
