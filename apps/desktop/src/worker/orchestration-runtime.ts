import type { AgentRuntime, RuntimePermissionGate } from '@desktop-agent/agent-runtime';
import { MemoryAgentRuntimeStore, type AgentRuntimeStore } from '@desktop-agent/agent-runtime/spi';
import type { MemoryRuntime } from '@desktop-agent/agent-runtime';
import {
  createJojoRuntime,
  RuntimeEnvironmentRegistry,
  type SharedRuntimeService
} from '@desktop-agent/runtime-composition';
import type { AgentEvent, HookRuntime, Message, ModelProvider, PermissionGate, ProviderConfig, SecretBroker } from '@desktop-agent/contracts';
import {
  accrueUsage,
  type AgentProfileRegistry,
  createBuiltinAgentProfileRegistry,
  createWorkflowToolRuntime,
  emptyUsage,
  NonInteractivePermissionGate,
  OrchestrationError,
  resolveAgentToolPolicy,
  structuredOutputInstruction,
  type LeafAgentRunRequest,
  type LeafAgentRunner,
  type WorkflowToolRuntime
} from '@desktop-agent/orchestration';
import { createProvider } from '@desktop-agent/providers';
import {
  DefaultPermissionRequestNormalizer,
  GovernanceRuntimePermissionGate,
  type PermissionAuditSink,
  type PermissionGovernanceEngine,
  type PermissionRequestNormalizer
} from '@desktop-agent/permission-governance';
import { createDefaultToolRuntime } from '@desktop-agent/tools-node';

const INCOMPLETE_STOP_REASONS = new Set(['max_iterations', 'length', 'max_tokens']);

type ProviderRuntime = { config: ProviderConfig; apiKey: string };

export type DesktopLeafAgentRunnerOptions = {
  resolveProvider(providerId: string): ProviderRuntime | undefined;
  trashDirectory: string;
  secretBroker?: SecretBroker;
  profileRegistry?: AgentProfileRegistry;
  runtimeStore?: AgentRuntimeStore;
  memoryRuntime?: MemoryRuntime;
  runtimeService?: SharedRuntimeService;
  governance?: {
    engine: PermissionGovernanceEngine;
    audit: PermissionAuditSink;
    normalizer?: PermissionRequestNormalizer;
  };
  createModelProvider?: (input: { runtime: ProviderRuntime; request: LeafAgentRunRequest }) => ModelProvider;
  resolveHooks?: (input: {
    sessionId: string;
    workingDirectory: string;
    signal: AbortSignal;
    onEvent: (event: AgentEvent) => void;
  }) => Promise<HookRuntime>;
};

function finalAssistantText(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant') continue;
    const text = message.content
      .filter((block): block is Extract<Message['content'][number], { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();
    if (text) return text;
  }
  return '';
}

export function createDesktopWorkflowToolRuntime(options: {
  trashDirectory: string;
  secretBroker?: SecretBroker;
  governance?: DesktopLeafAgentRunnerOptions['governance'];
}): WorkflowToolRuntime {
  const runtime = createDefaultToolRuntime({
    trashDirectory: options.trashDirectory,
    ...(options.secretBroker ? { secretBroker: options.secretBroker } : {})
  });
  const governanceGate = options.governance
    ? new GovernanceRuntimePermissionGate(
        runtime.permissionGate,
        options.governance.engine,
        options.governance.normalizer ?? new DefaultPermissionRequestNormalizer(),
        options.governance.audit
      )
    : undefined;
  return createWorkflowToolRuntime({
    tools: runtime.tools,
    permissionGate: new NonInteractivePermissionGate(runtime.permissionGate),
    ...(governanceGate ? {
      contextualPermissionGate: {
        check: (call, invocation) => governanceGate.check(call, {
          sessionId: invocation.sessionId,
          laneId: `workflow:${invocation.workflowId}:${invocation.workflowStepId}`,
          runId: invocation.workflowRunId,
          providerId: invocation.providerId,
          model: invocation.model,
          workingDirectory: invocation.workingDirectory,
          executionScope: { kind: 'workspace', workingDirectory: invocation.workingDirectory },
          actor: { kind: 'workflow', id: invocation.workflowRunId, profile: 'tool-step' },
          workflow: { id: invocation.workflowId, stepId: invocation.workflowStepId }
        })
      }
    } : {})
  });
}

export function createDesktopLeafAgentRunner(options: DesktopLeafAgentRunnerOptions): LeafAgentRunner {
  const profileRegistry = options.profileRegistry ?? createBuiltinAgentProfileRegistry();
  const runtimeStore = options.runtimeStore ?? new MemoryAgentRuntimeStore();
  const environments = options.runtimeService?.environments ?? new RuntimeEnvironmentRegistry();
  const sharedRuntime: AgentRuntime | Promise<AgentRuntime> = options.runtimeService?.runtime ?? createJojoRuntime({
    host: { kind: 'desktop' },
    store: runtimeStore,
    providers: environments.providers,
    tools: environments.tools,
    permissions: environments.permissions,
    hooks: environments.hooks,
    runContext: environments.runContext,
    telemetry: environments.telemetry,
    ...(options.memoryRuntime ? { memory: options.memoryRuntime } : {})
  });
  const continuations = new Map<string, { request: LeafAgentRunRequest }>();
  const execute = async (
    request: LeafAgentRunRequest,
    task: string,
    signal: AbortSignal,
    onEvent: Parameters<LeafAgentRunner['run']>[2],
    continuationId?: string
  ) => {
      const profile = profileRegistry.get(request.profile, request.workingDirectory);
      const providerRuntime = options.resolveProvider(request.providerId);
      if (!providerRuntime) throw new OrchestrationError('provider_error', `Provider is unavailable: ${request.providerId}`);
      const model = profile.model && profile.model !== 'inherit' ? profile.model : request.model;
      if (!providerRuntime.config.models.includes(model)) {
        throw new OrchestrationError('provider_error', `Model ${model} is not configured.`);
      }
      const toolRuntime = createDefaultToolRuntime({
        trashDirectory: options.trashDirectory,
        ...(options.secretBroker ? { secretBroker: options.secretBroker } : {})
      });
      const policy = resolveAgentToolPolicy(
        toolRuntime.tools.map((tool) => tool.definition.name),
        profile,
        {
          ...(request.tools ? { tools: request.tools } : {}),
          ...(request.readOnly !== undefined ? { readOnly: request.readOnly } : {})
        }
      );
      const allowedTools = new Set(policy.allowedTools);
      const executionScope = { kind: 'workspace' as const, workingDirectory: request.workingDirectory };
      const tools = toolRuntime.tools
        .filter((tool) => allowedTools.has(tool.definition.name))
        .map((tool) => ({
          ...tool,
          execute: (input: unknown, context: Parameters<typeof tool.execute>[1]) => tool.execute(input, {
            ...context,
            workingDirectory: request.workingDirectory,
            executionScope
          })
        }));
      const usage = emptyUsage();
      const hooks = request.hooks ?? await options.resolveHooks?.({
        sessionId: request.sessionId,
        workingDirectory: request.workingDirectory,
        signal,
        onEvent
      });
      const provider = options.createModelProvider
        ? options.createModelProvider({ runtime: providerRuntime, request })
        : createProvider(providerRuntime.config, providerRuntime.apiKey);
      const laneId = request.runtimeLane?.name ?? `agent:${request.id}`;
      const basePermissionGate: PermissionGate = toolRuntime.permissionGate;
      const scopedPermissionGate: PermissionGate = {
        check: (call, context) => basePermissionGate.check(call, {
          ...context,
          executionScope
        })
      };
      const permissionGate: RuntimePermissionGate = options.governance
        ? new GovernanceRuntimePermissionGate(
            scopedPermissionGate,
            options.governance.engine,
            options.governance.normalizer ?? new DefaultPermissionRequestNormalizer(),
            options.governance.audit
          )
        : new NonInteractivePermissionGate(scopedPermissionGate);
      const binding = environments.bind(request.sessionId, laneId, {
        provider,
        tools: { snapshot: () => tools },
        permissions: {
          check: (call, context) => permissionGate.check(call, {
            ...context,
            workingDirectory: request.workingDirectory
          })
        },
        ...(hooks ? { hooks } : {}),
        ...(request.memoryBinding ? {
          runContext: {
            ...(request.memoryBinding?.projectIdentity
              ? { projectIdentity: request.memoryBinding.projectIdentity }
              : {}),
            ...(request.memoryBinding ? { memoryBinding: request.memoryBinding } : {})
          }
        } : {}),
        telemetry: {
          diagnostic: (event) => {
            if (event.type === 'usage') accrueUsage(usage, event);
            onEvent(event);
          }
        }
      });
      try {
        const runtime = await sharedRuntime;
        const session = await runtime.openSession({
          id: request.sessionId,
          executionScope
        });
        const existingLane = (await session.listLanes()).some((lane) => lane.id === laneId);
        const lane = existingLane
          ? await session.getLane(laneId)
          : await session.createLane({
              id: laneId,
              parentLaneId: request.runtimeLane?.parentLane ?? 'main'
            });
        const workflowLane = request.runtimeLane?.name.startsWith('workflow:')
          ? request.runtimeLane.name.split(':')
          : undefined;
        const handle = await lane.run({
          input: task,
          model,
          providerId: request.providerId,
          actor: {
            kind: workflowLane ? 'workflow' : 'subagent',
            id: request.id,
            profile: request.profile
          },
          ...(workflowLane ? {
            workflow: {
              id: workflowLane[1] ?? request.id,
              ...(workflowLane[2] ? { stepId: workflowLane[2] } : {})
            }
          } : {}),
          instructions: [
            profile.systemPrompt,
            ...(request.outputSchema ? [structuredOutputInstruction(request.outputSchema)] : [])
          ],
          signal,
          budget: {
            ...(request.maxIterations !== undefined ? { maxIterations: request.maxIterations } : {}),
            allowPartialOnLimit: true,
            contextWindowTokens: providerRuntime.config.contextWindowTokens,
            maxOutputTokens: Math.min(providerRuntime.config.maxOutputTokens, 4_096)
          }
        });
        const result = await handle.result;
        if (result.status === 'failed') {
          const code = result.error?.code ?? 'provider_error';
          throw new OrchestrationError(
            code === 'timeout' ? 'provider_timeout' : 'provider_error',
            result.error?.message ?? 'Agent runtime failed.',
            { providerCode: code }
          );
        }
        const nextContinuationId = request.continuable ? continuationId ?? `sac_${crypto.randomUUID()}` : undefined;
        if (nextContinuationId) continuations.set(nextContinuationId, { request });
        return {
          result: result.finalText ?? finalAssistantText(result.messages),
          stopReason: result.stopReason ?? (result.status === 'cancelled' ? 'cancelled' : 'stop'),
          model,
          ...(nextContinuationId ? { continuationId: nextContinuationId } : {}),
          usage,
          incomplete: result.stopReason ? INCOMPLETE_STOP_REASONS.has(result.stopReason) : false
        };
      } finally {
        binding.dispose();
      }
  };
  return {
    run: (request, signal, onEvent) => execute(request, request.task, signal, onEvent),
    continue: async (continuationId, task, signal, onEvent) => {
      const continuation = continuations.get(continuationId);
      if (!continuation) throw new OrchestrationError('subagent_closed', `Sub-agent continuation is unavailable: ${continuationId}`);
      return execute(continuation.request, task, signal, onEvent, continuationId);
    },
    close: async (continuationId) => {
      continuations.delete(continuationId);
    }
  };
}
