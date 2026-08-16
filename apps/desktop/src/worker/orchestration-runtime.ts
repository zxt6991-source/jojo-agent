import { AgentError, runAgentTurn } from '@desktop-agent/agent-core';
import type { Message, ProviderConfig } from '@desktop-agent/contracts';
import {
  accrueUsage,
  type AgentProfileRegistry,
  createBuiltinAgentProfileRegistry,
  emptyUsage,
  NonInteractivePermissionGate,
  OrchestrationError,
  resolveAgentToolPolicy,
  structuredOutputInstruction,
  type LeafAgentRunRequest,
  type LeafAgentRunner
} from '@desktop-agent/orchestration';
import { createProvider } from '@desktop-agent/providers';
import { createDefaultToolRuntime } from '@desktop-agent/tools-node';

const INCOMPLETE_STOP_REASONS = new Set(['max_iterations', 'length', 'max_tokens']);

type ProviderRuntime = { config: ProviderConfig; apiKey: string };

export type DesktopLeafAgentRunnerOptions = {
  resolveProvider(providerId: string): ProviderRuntime | undefined;
  trashDirectory: string;
  profileRegistry?: AgentProfileRegistry;
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

export function createDesktopLeafAgentRunner(options: DesktopLeafAgentRunnerOptions): LeafAgentRunner {
  const profileRegistry = options.profileRegistry ?? createBuiltinAgentProfileRegistry();
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
      let result: Awaited<ReturnType<typeof runAgentTurn>>;
      try {
        result = await runAgentTurn({
          sessionId: request.sessionId,
          workingDirectory: request.workingDirectory,
          model,
          history,
          userText: task,
          provider: createProvider(providerRuntime.config, providerRuntime.apiKey),
          tools,
          instructions: [
            profile.systemPrompt,
            ...(request.outputSchema ? [structuredOutputInstruction(request.outputSchema)] : [])
          ],
          permissionGate: new NonInteractivePermissionGate(toolRuntime.permissionGate),
          signal,
          maxIterations: request.maxIterations,
          allowPartialOnMaxIterations: true,
          contextWindowTokens: providerRuntime.config.contextWindowTokens,
          maxOutputTokens: Math.min(providerRuntime.config.maxOutputTokens, 4_096),
          emit: (event) => {
            if (event.type === 'usage') accrueUsage(usage, event);
            onEvent(event);
          },
          approve: async () => false
        });
      } catch (error) {
        if (error instanceof AgentError) {
          throw new OrchestrationError(error.code === 'timeout' ? 'provider_timeout' : 'provider_error', error.message, { providerCode: error.code });
        }
        throw error;
      }
      const nextContinuationId = request.continuable ? continuationId ?? `sac_${crypto.randomUUID()}` : undefined;
      if (nextContinuationId) continuations.set(nextContinuationId, { request, history: result.messages });
      return {
        result: finalAssistantText(result.messages),
        stopReason: result.stopReason,
        model,
        ...(nextContinuationId ? { continuationId: nextContinuationId } : {}),
        usage,
        incomplete: INCOMPLETE_STOP_REASONS.has(result.stopReason)
      };
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
