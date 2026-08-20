import type { Message, Tool, ToolCall, ToolDefinition, ToolResult } from '@desktop-agent/contracts';
import { AgentError, errorMessage, isAbortError, throwIfAborted } from './errors.js';
import {
  appendMessage,
  createAssistantMessage,
  createContinuationMessage,
  createNoProgressFinalMessage,
  createToolMessage,
  createUserMessage
} from './messages.js';
import { runModelStep } from './model-step.js';
import { prepareModelContext } from './context-manager.js';
import { executeToolCall } from './tool-execution.js';
import type { AgentRunOptions, AgentRunResult } from './types.js';

const DEFAULT_MAX_ITERATIONS = 12;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
const MAX_OUTPUT_CONTINUATIONS = 2;
const NO_PROGRESS_RECOVERY_TOOL_STEPS = 2;

type TurnState = {
  messages: Message[];
  toolsByName: Map<string, Tool>;
  toolDefinitions: ToolDefinition[];
  executedCallIds: Set<string>;
  toolCallCounts: Map<string, number>;
  observationFingerprints: Set<string>;
};

function currentTools(options: AgentRunOptions): Tool[] {
  const contextWindowTokens = options.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const tools = [...options.tools, ...(options.getTools?.({ contextWindowTokens, maxOutputTokens }) ?? [])];
  return [...new Map(tools.map((tool) => [tool.definition.name, tool])).values()];
}

function refreshTools(state: TurnState, options: AgentRunOptions): void {
  const tools = currentTools(options);
  state.toolsByName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  state.toolDefinitions = tools.map((tool) => tool.definition);
}

function createTurnState(options: AgentRunOptions): TurnState {
  const tools = currentTools(options);
  return {
    messages: [...options.history],
    toolsByName: new Map(tools.map((tool) => [tool.definition.name, tool])),
    toolDefinitions: tools.map((tool) => tool.definition),
    executedCallIds: new Set<string>(),
    toolCallCounts: new Map<string, number>(),
    observationFingerprints: new Set<string>()
  };
}

async function executeToolCalls(
  calls: ToolCall[],
  state: TurnState,
  options: AgentRunOptions
): Promise<boolean> {
  let noProgressDetected = false;
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index]!;
    let result: ToolResult;
    try {
      result = await executeToolCall(call, state, options);
    } catch (error) {
      if (!options.signal.aborted && !isAbortError(error)) throw error;
      for (const interruptedCall of calls.slice(index)) {
        const interrupted: ToolResult = {
          callId: interruptedCall.id,
          ok: false,
          code: 'cancelled',
          content: 'Tool execution was interrupted before a result was recorded.'
        };
        await appendMessage(options, state.messages, createToolMessage(interrupted));
        options.emit({ type: 'tool.finished', id: interruptedCall.id, result: interrupted });
      }
      throw error;
    }
    await appendMessage(options, state.messages, createToolMessage(result));
    noProgressDetected ||= result.code === 'no_progress';
  }
  return noProgressDetected;
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
    await appendMessage(options, state.messages, createUserMessage(options.userText, options.userImages));
    let outputContinuations = 0;
    let recoveryToolStepsRemaining: number | null = null;
    let finalResponseOnly = false;

    for (
      let iteration = 0;
      iteration < maxIterations || (finalResponseOnly && iteration === maxIterations);
      iteration += 1
    ) {
      throwIfAborted(options.signal);
      refreshTools(state, options);
      if (finalResponseOnly) {
        state.toolsByName = new Map();
        state.toolDefinitions = [];
      }

      const contextWindowTokens = options.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
      const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
      const context = await prepareModelContext({
        messages: state.messages,
        tools: state.toolDefinitions,
        contextWindowTokens,
        maxOutputTokens,
        ...(options.summarize ? { summarize: options.summarize } : {}),
        signal: options.signal
      });
      options.emit({
        type: 'context.updated', estimatedTokens: context.estimatedTokens, contextWindowTokens,
        compactedMessages: context.compactedMessages, reclaimedToolCharacters: context.reclaimedToolCharacters
      });

      const step = await runModelStep({
        model: options.model,
        messages: context.messages,
        toolDefinitions: state.toolDefinitions,
        ...(options.instructions?.length ? { instructions: options.instructions } : {}),
        provider: options.provider,
        signal: options.signal,
        emit: options.emit,
        maxOutputTokens
      });

      await appendMessage(
        options,
        state.messages,
        createAssistantMessage(step.text, step.calls)
      );

      if (step.calls.length === 0) {
        if ((step.stopReason === 'length' || step.stopReason === 'max_tokens') && outputContinuations < MAX_OUTPUT_CONTINUATIONS) {
          outputContinuations += 1;
          options.emit({ type: 'output.continuing', attempt: outputContinuations });
          await appendMessage(options, state.messages, createContinuationMessage());
          continue;
        }
        options.emit({ type: 'turn.completed', stopReason: step.stopReason });
        return { messages: state.messages, stopReason: step.stopReason };
      }

      const noProgressDetected = await executeToolCalls(step.calls, state, options);
      if (finalResponseOnly) {
        throw new AgentError(
          'no_progress',
          'The model requested another tool after tool use was paused for lack of progress.'
        );
      }
      if (noProgressDetected && recoveryToolStepsRemaining === null) {
        recoveryToolStepsRemaining = NO_PROGRESS_RECOVERY_TOOL_STEPS;
      } else if (recoveryToolStepsRemaining !== null) {
        recoveryToolStepsRemaining -= 1;
        if (recoveryToolStepsRemaining <= 0) {
          finalResponseOnly = true;
          await appendMessage(options, state.messages, createNoProgressFinalMessage());
        }
      }
      outputContinuations = 0;
    }

    if (options.allowPartialOnMaxIterations) {
      options.emit({ type: 'turn.completed', stopReason: 'max_iterations' });
      return { messages: state.messages, stopReason: 'max_iterations' };
    }
    throw new AgentError('max_iterations', `The turn exceeded ${maxIterations} model iterations.`);
  } catch (error) {
    return handleTurnError(error, options, state.messages);
  }
}
