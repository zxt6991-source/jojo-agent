import { AgentError, runAgentTurn } from '@desktop-agent/agent-core';
import type { Message, ProviderConfig } from '@desktop-agent/contracts';
import {
  accrueUsage,
  emptyUsage,
  NonInteractivePermissionGate,
  OrchestrationError,
  type LeafAgentRunner
} from '@desktop-agent/orchestration';
import { createProvider } from '@desktop-agent/providers';
import { createDefaultToolRuntime } from '@desktop-agent/tools-node';

const EXPLORE_TOOLS = new Set(['read_file', 'list_files', 'grep', 'glob', 'web_search', 'web_fetch']);
const INCOMPLETE_STOP_REASONS = new Set(['max_iterations', 'length', 'max_tokens']);

type ProviderRuntime = { config: ProviderConfig; apiKey: string };

export type DesktopLeafAgentRunnerOptions = {
  resolveProvider(providerId: string): ProviderRuntime | undefined;
  trashDirectory: string;
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
  return {
    async run(request, signal, onEvent) {
      const providerRuntime = options.resolveProvider(request.providerId);
      if (!providerRuntime) throw new OrchestrationError('provider_error', `Provider is unavailable: ${request.providerId}`);
      if (!providerRuntime.config.models.includes(request.model)) {
        throw new OrchestrationError('provider_error', `Model ${request.model} is not configured.`);
      }
      if (request.profile !== 'explore' && request.profile !== 'synthesize') {
        throw new OrchestrationError('invalid_profile', `Unsupported agent profile: ${String(request.profile)}`);
      }
      const toolRuntime = createDefaultToolRuntime({ trashDirectory: options.trashDirectory });
      const tools = request.profile === 'explore'
        ? toolRuntime.tools.filter((tool) => EXPLORE_TOOLS.has(tool.definition.name))
        : [];
      const usage = emptyUsage();
      let result: Awaited<ReturnType<typeof runAgentTurn>>;
      try {
        result = await runAgentTurn({
          sessionId: request.sessionId,
          workingDirectory: request.workingDirectory,
          model: request.model,
          history: [],
          userText: request.task,
          provider: createProvider(providerRuntime.config, providerRuntime.apiKey),
          tools,
          instructions: [request.profile === 'explore'
            ? 'You are a read-only coding sub-agent. Focus only on the delegated task. Inspect the project using the available read-only tools. Return concise findings with relevant file paths, symbols, and unresolved uncertainties.'
            : 'You are a synthesis sub-agent. Use only the supplied dependency results. Distinguish consensus, conflicts, missing evidence, and incomplete upstream results.'],
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
      return {
        result: finalAssistantText(result.messages),
        stopReason: result.stopReason,
        usage,
        incomplete: INCOMPLETE_STOP_REASONS.has(result.stopReason)
      };
    }
  };
}
