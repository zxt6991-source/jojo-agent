import {
  createAgentRuntime
} from '@desktop-agent/agent-runtime';
import { MemoryAgentRuntimeStore, type AgentRuntimeStore } from '@desktop-agent/agent-runtime/store';
import type { MemoryRuntime } from '@desktop-agent/agent-runtime/memory';
import type { AgentEvent, HookRuntime, Message, ModelProvider, ProviderConfig } from '@desktop-agent/contracts';
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
import { createDefaultToolRuntime } from '@desktop-agent/tools-node';

const INCOMPLETE_STOP_REASONS = new Set(['max_iterations', 'length', 'max_tokens']);

type ProviderRuntime = { config: ProviderConfig; apiKey: string };

export type DesktopLeafAgentRunnerOptions = {
  resolveProvider(providerId: string): ProviderRuntime | undefined;
  trashDirectory: string;
  profileRegistry?: AgentProfileRegistry;
  runtimeStore?: AgentRuntimeStore;
  memoryRuntime?: MemoryRuntime;
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

export function createDesktopWorkflowToolRuntime(options: { trashDirectory: string }): WorkflowToolRuntime {
  const runtime = createDefaultToolRuntime({ trashDirectory: options.trashDirectory });
  return createWorkflowToolRuntime({
    tools: runtime.tools,
    permissionGate: new NonInteractivePermissionGate(runtime.permissionGate)
  });
}

export function createDesktopLeafAgentRunner(options: DesktopLeafAgentRunnerOptions): LeafAgentRunner {
  const profileRegistry = options.profileRegistry ?? createBuiltinAgentProfileRegistry();
  const runtimeStore = options.runtimeStore ?? new MemoryAgentRuntimeStore();
  const continuations = new Map<string, { request: LeafAgentRunRequest; history: Message[] }>();
  const execute = async (
    request: LeafAgentRunRequest,
    history: Message[],
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
      const toolRuntime = createDefaultToolRuntime({ trashDirectory: options.trashDirectory });
      const policy = resolveAgentToolPolicy(
        toolRuntime.tools.map((tool) => tool.definition.name),
        profile,
        {
          ...(request.tools ? { tools: request.tools } : {}),
          ...(request.readOnly !== undefined ? { readOnly: request.readOnly } : {})
        }
      );
      const allowedTools = new Set(policy.allowedTools);
      const tools = toolRuntime.tools.filter((tool) => allowedTools.has(tool.definition.name));
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
      const runtime = createAgentRuntime({
        store: runtimeStore,
        environment: {
          providers: { resolve: () => provider },
          tools: { resolve: () => tools },
          permissions: new NonInteractivePermissionGate(toolRuntime.permissionGate),
          ...(options.memoryRuntime ? { memory: options.memoryRuntime } : {}),
          ...(hooks ? { hooks } : {}),
          telemetry: {
            diagnostic: (event) => {
              if (event.type === 'usage') accrueUsage(usage, event);
              onEvent(event);
            }
          }
        }
      });
      try {
        const session = await runtime.openSession({
          id: request.sessionId,
          executionScope: { kind: 'workspace', workingDirectory: request.workingDirectory },
          workingDirectory: request.workingDirectory
        });
        const existingLane = (await session.listLanes()).some((lane) => lane.id === laneId);
        const lane = existingLane
          ? await session.getLane(laneId)
          : await session.createLane({
              id: laneId,
              parentLaneId: request.runtimeLane?.parentLane ?? 'main'
            });
        const handle = await lane.run({
          input: task,
          workingDirectory: request.workingDirectory,
          model,
          providerId: request.providerId,
          history,
          ...(request.memoryBinding ? {
            memoryBinding: request.memoryBinding,
            ...(request.memoryBinding.projectIdentity
              ? { projectIdentity: request.memoryBinding.projectIdentity }
              : {})
          } : {}),
          ...(hooks ? {
            hookMeta: {
              transport: 'desktop' as const,
              agent: {
                kind: request.runtimeLane?.name.startsWith('workflow:') ? 'workflow' as const : 'subagent' as const,
                id: request.id,
                profile: request.profile
              }
            }
          } : {}),
          instructions: [
            profile.systemPrompt,
            ...(request.outputSchema ? [structuredOutputInstruction(request.outputSchema)] : [])
          ],
          signal,
          maxIterations: request.maxIterations,
          allowPartialOnMaxIterations: true,
          contextWindowTokens: providerRuntime.config.contextWindowTokens,
          maxOutputTokens: Math.min(providerRuntime.config.maxOutputTokens, 4_096)
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
        if (nextContinuationId) continuations.set(nextContinuationId, { request, history: result.messages });
        return {
          result: result.finalText ?? finalAssistantText(result.messages),
          stopReason: result.stopReason ?? (result.status === 'cancelled' ? 'cancelled' : 'stop'),
          model,
          ...(nextContinuationId ? { continuationId: nextContinuationId } : {}),
          usage,
          incomplete: result.stopReason ? INCOMPLETE_STOP_REASONS.has(result.stopReason) : false
        };
      } finally {
        await runtime.close();
      }
  };
  return {
    run: (request, signal, onEvent) => execute(request, [], request.task, signal, onEvent),
    continue: async (continuationId, task, signal, onEvent) => {
      const continuation = continuations.get(continuationId);
      if (!continuation) throw new OrchestrationError('subagent_closed', `Sub-agent continuation is unavailable: ${continuationId}`);
      return execute(continuation.request, continuation.history, task, signal, onEvent, continuationId);
    },
    close: async (continuationId) => {
      continuations.delete(continuationId);
    }
  };
}
