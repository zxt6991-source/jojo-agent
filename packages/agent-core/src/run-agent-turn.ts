import type { Message, Tool, ToolCall, ToolDefinition } from '@desktop-agent/contracts';
import { AgentError, errorMessage, isAbortError, throwIfAborted } from './errors.js';
import {
  appendMessage,
  createAssistantMessage,
  createToolMessage,
  createUserMessage
} from './messages.js';
import { runModelStep } from './model-step.js';
import { executeToolCall } from './tool-execution.js';
import type { AgentRunOptions, AgentRunResult } from './types.js';

const DEFAULT_MAX_ITERATIONS = 8;

type TurnState = {
  messages: Message[];
  toolsByName: Map<string, Tool>;
  toolDefinitions: ToolDefinition[];
  executedCallIds: Set<string>;
};

function createTurnState(options: AgentRunOptions): TurnState {
  return {
    messages: [...options.history],
    toolsByName: new Map(options.tools.map((tool) => [tool.definition.name, tool])),
    toolDefinitions: options.tools.map((tool) => tool.definition),
    executedCallIds: new Set<string>()
  };
}

async function executeToolCalls(
  calls: ToolCall[],
  state: TurnState,
  options: AgentRunOptions
): Promise<void> {
  for (const call of calls) {
    const result = await executeToolCall(call, state, options);
    await appendMessage(options, state.messages, createToolMessage(result));
  }
}

function handleTurnError(
  error: unknown,
  options: AgentRunOptions,
  messages: Message[]
): AgentRunResult {
  if (options.signal.aborted || isAbortError(error)) {
    options.emit({ type: 'turn.cancelled' });
    return { messages, stopReason: 'cancelled' };
  }

  options.emit({
    type: 'turn.failed',
    code: error instanceof AgentError ? error.code : 'agent_error',
    message: errorMessage(error)
  });
  throw error;
}

export async function runAgentTurn(options: AgentRunOptions): Promise<AgentRunResult> {
  const state = createTurnState(options);
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  options.emit({ type: 'turn.started', sessionId: options.sessionId, turnId: crypto.randomUUID() });

  try {
    await appendMessage(options, state.messages, createUserMessage(options.userText));

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      throwIfAborted(options.signal);

      const step = await runModelStep({
        model: options.model,
        messages: state.messages,
        toolDefinitions: state.toolDefinitions,
        provider: options.provider,
        signal: options.signal,
        emit: options.emit
      });

      await appendMessage(
        options,
        state.messages,
        createAssistantMessage(step.text, step.calls)
      );

      if (step.calls.length === 0) {
        options.emit({ type: 'turn.completed', stopReason: step.stopReason });
        return { messages: state.messages, stopReason: step.stopReason };
      }

      await executeToolCalls(step.calls, state, options);
    }

    throw new AgentError(
      'max_iterations',
      `The turn exceeded ${maxIterations} model iterations.`
    );
  } catch (error) {
    return handleTurnError(error, options, state.messages);
  }
}
