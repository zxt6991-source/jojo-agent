import type { AgentEvent, Message, Tool, ToolCall, ToolDefinition, ToolResult } from '@desktop-agent/contracts';
import { AgentError, errorMessage, isAbortError, throwIfAborted } from './errors.js';
import {
  appendMessage,
  createAssistantMessage,
  createContinuationMessage,
  createIterationLimitFinalMessage,
  createNoProgressFinalMessage,
  createSafetyFinalMessage,
  createToolMessage,
  createUserMessage
} from './messages.js';
import { runModelStep } from './model-step.js';
import { calculateContextBudget, estimateContextTokens, prepareModelContext } from './context-manager.js';
import { createIterationBudgetPolicy, extendIterationBudget, iterationBudgetInstruction } from './iteration-budget.js';
import { executeToolCall } from './tool-execution.js';
import { detectRepeatedCycle, recordIterationFingerprint } from './loop/cycle-detector.js';
import { fingerprintToolBatch } from './loop/fingerprint.js';
import { evaluateLoopGuards, type LoopGuardContext } from './loop/guards.js';
import {
  DEFAULT_AGENT_LOOP_SAFETY,
  DEFAULT_AGENT_LOOP_RESOURCE_BUDGET,
  emptyLoopUsage,
  type AgentStopReason,
  type LoopUsage,
  type PollingCallState
} from './loop/types.js';
import type { AgentRunOptions, AgentRunResult } from './types.js';

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
  pollingCalls: Map<string, PollingCallState>;
  repeatedToolCalls: number;
  duplicateObservations: number;
  recentIterationFingerprints: string[];
  usage: LoopUsage;
  toolCalls: number;
  compactions: number;
  startedAt: number;
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
    observationFingerprints: new Set<string>(),
    pollingCalls: new Map<string, PollingCallState>(),
    repeatedToolCalls: 0,
    duplicateObservations: 0,
    recentIterationFingerprints: [],
    usage: emptyLoopUsage(),
    toolCalls: 0,
    compactions: 0,
    startedAt: Date.now()
  };
}

function accrueUsage(usage: LoopUsage, event: AgentEvent): void {
  if (event.type !== 'usage') return;
  usage.inputTokens += event.inputTokens ?? 0;
  usage.outputTokens += event.outputTokens ?? 0;
  usage.cacheReadInputTokens += event.cacheReadInputTokens ?? 0;
  usage.cacheWriteInputTokens += event.cacheWriteInputTokens ?? 0;
  usage.totalTokens += (event.inputTokens ?? 0) + (event.outputTokens ?? 0);
  usage.costUsd += event.costUsd ?? 0;
}

function guardContext(
  state: TurnState,
  options: AgentRunOptions,
  iterationBudget: ReturnType<typeof createIterationBudgetPolicy>,
  iteration: number,
  madeProgress: boolean,
  recoveryStepsRemaining: number | null,
  cycleDetected = false
): LoopGuardContext {
  const safety = options.loopSafety ?? DEFAULT_AGENT_LOOP_SAFETY;
  return {
    iteration,
    currentLimit: iterationBudget.currentLimit,
    runLimit: iterationBudget.runLimit,
    absoluteLimit: iterationBudget.absoluteLimit,
    limitReason: iterationBudget.limitReason,
    dynamic: iterationBudget.dynamic,
    extensionStep: iterationBudget.extensionStep,
    elapsedMs: Date.now() - state.startedAt,
    madeProgress,
    recoveryStepsRemaining,
    cycleDetected,
    usage: state.usage,
    toolCalls: state.toolCalls,
    compactions: state.compactions,
    budget: { ...DEFAULT_AGENT_LOOP_RESOURCE_BUDGET, ...(options.loopBudget ?? {}) },
    maxCompactionsPerTurn: safety.maxCompactionsPerTurn
  };
}

async function executeToolCalls(
  calls: ToolCall[],
  state: TurnState,
  options: AgentRunOptions
): Promise<{ noProgressDetected: boolean; madeProgress: boolean }> {
  let noProgressDetected = false;
  let madeProgress = false;
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
    madeProgress ||= result.ok;
  }
  return { noProgressDetected, madeProgress };
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
  let iterationBudget = createIterationBudgetPolicy(options);

  options.emit({ type: 'turn.started', sessionId: options.sessionId, turnId: crypto.randomUUID() });

  try {
    await appendMessage(options, state.messages, createUserMessage(options.userText, options.userImages));
    let outputContinuations = 0;
    let recoveryToolStepsRemaining: number | null = null;
    let finalResponseOnly = false;
    let finalResponseReason: AgentStopReason | null = null;

    for (
      let iteration = 0;
      iteration < iterationBudget.currentLimit
        || (finalResponseOnly && iteration <= iterationBudget.currentLimit + MAX_OUTPUT_CONTINUATIONS);
      iteration += 1
    ) {
      throwIfAborted(options.signal);
      if (!finalResponseOnly) {
        const beforeStep = await evaluateLoopGuards(guardContext(
          state, options, iterationBudget, iteration, false, recoveryToolStepsRemaining
        ));
        if (beforeStep.action === 'finalize') {
          finalResponseOnly = true;
          finalResponseReason = beforeStep.reason;
          await appendMessage(options, state.messages, createSafetyFinalMessage(beforeStep.reason, iterationBudget.absoluteLimit));
        } else if (beforeStep.action === 'stop') {
          options.emit({ type: 'turn.completed', stopReason: beforeStep.reason });
          return { messages: state.messages, stopReason: beforeStep.reason };
        }
      }
      refreshTools(state, options);
      if (finalResponseOnly) {
        state.toolsByName = new Map();
        state.toolDefinitions = [];
      }

      const contextWindowTokens = options.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
      const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
      const iterationInstruction = finalResponseOnly
        ? 'This is the mandatory tool-free final response. Do not request tools. Report completed work, concrete results, unfinished work, and the next action.'
        : iterationBudgetInstruction(iterationBudget, iteration);
      const instructions = [...(options.instructions ?? []), iterationInstruction];
      const budget = calculateContextBudget({
        tools: state.toolDefinitions,
        instructions,
        contextWindowTokens,
        maxOutputTokens
      });
      if (budget.overCapacity) {
        options.emit({
          type: 'context.updated',
          estimatedTokens: estimateContextTokens(state.messages, state.toolDefinitions, instructions),
          contextWindowTokens,
          compactedMessages: 0,
          reclaimedToolCharacters: 0,
          fixedTokens: budget.fixedTokens,
          targetTokens: budget.targetTokens,
          messageBudgetTokens: budget.messageBudgetTokens,
          overCapacity: true,
          iteration: Math.min(iteration + 1, iterationBudget.currentLimit),
          maxIterations: iterationBudget.currentLimit,
          runMaxIterations: iterationBudget.runLimit,
          absoluteMaxIterations: iterationBudget.absoluteLimit,
          toolCalls: state.toolCalls,
          repeatedToolCalls: state.repeatedToolCalls,
          duplicateObservations: state.duplicateObservations,
          elapsedMs: Date.now() - state.startedAt,
          finalResponseOnly
        });
      }
      const context = await prepareModelContext({
        messages: state.messages,
        tools: state.toolDefinitions,
        instructions,
        contextWindowTokens,
        maxOutputTokens,
        ...(options.summarize ? { summarize: options.summarize } : {}),
        signal: options.signal
      });
      if (context.compactedMessages > 0) state.compactions += 1;
      options.emit({
        type: 'context.updated', estimatedTokens: context.estimatedTokens, contextWindowTokens,
        compactedMessages: context.compactedMessages, reclaimedToolCharacters: context.reclaimedToolCharacters,
        fixedTokens: context.budget.fixedTokens,
        targetTokens: context.budget.targetTokens,
        messageBudgetTokens: context.budget.messageBudgetTokens,
        overCapacity: context.budget.overCapacity,
        iteration: Math.min(iteration + 1, iterationBudget.currentLimit),
        maxIterations: iterationBudget.currentLimit,
        runMaxIterations: iterationBudget.runLimit,
        absoluteMaxIterations: iterationBudget.absoluteLimit,
        toolCalls: state.toolCalls,
        repeatedToolCalls: state.repeatedToolCalls,
        duplicateObservations: state.duplicateObservations,
        elapsedMs: Date.now() - state.startedAt,
        finalResponseOnly
      });

      const step = await runModelStep({
        model: options.model,
        messages: context.messages,
        toolDefinitions: state.toolDefinitions,
        instructions,
        provider: options.provider,
        signal: options.signal,
        emit: (event) => {
          accrueUsage(state.usage, event);
          options.emit(event);
        },
        maxOutputTokens
      });

      let cycleDetected = false;
      if (!finalResponseOnly && step.calls.length > 0) {
        const safety = options.loopSafety ?? DEFAULT_AGENT_LOOP_SAFETY;
        const fingerprint = fingerprintToolBatch(step.calls, state.toolsByName);
        state.recentIterationFingerprints = recordIterationFingerprint(
          state.recentIterationFingerprints,
          fingerprint,
          safety.recentIterationWindow
        );
        cycleDetected = Boolean(detectRepeatedCycle(
          state.recentIterationFingerprints,
          safety.maxCyclePeriod,
          safety.requiredCycleRepeats
        ));
      }
      const predictedToolCalls = state.toolCalls + step.calls.length;
      const maxToolCalls = options.loopBudget?.maxToolCalls
        ?? DEFAULT_AGENT_LOOP_RESOURCE_BUDGET.maxToolCalls;
      const toolBudgetExceeded = maxToolCalls !== undefined && predictedToolCalls > maxToolCalls;
      const afterModelDecision = await evaluateLoopGuards(guardContext(
        state, options, iterationBudget, iteration, false, recoveryToolStepsRemaining
      ));
      const resourceReason = step.calls.length > 0 && afterModelDecision.action === 'finalize'
        && ['time_budget', 'token_budget', 'cost_budget', 'context_budget', 'tool_call_budget']
          .includes(afterModelDecision.reason)
        ? afterModelDecision.reason
        : toolBudgetExceeded ? 'tool_call_budget' as const : null;

      await appendMessage(
        options,
        state.messages,
        createAssistantMessage(step.text, cycleDetected || resourceReason ? [] : step.calls, undefined, {
          iteration: Math.min(iteration + 1, iterationBudget.currentLimit),
          ...(finalResponseOnly ? { finalResponseOnly: true } : {})
        })
      );

      if (cycleDetected || resourceReason) {
        const reason = cycleDetected ? 'loop_detected' as const : resourceReason!;
        finalResponseOnly = true;
        finalResponseReason = reason;
        await appendMessage(options, state.messages, createSafetyFinalMessage(reason, iterationBudget.absoluteLimit));
        outputContinuations = 0;
        continue;
      }

      if (step.calls.length === 0) {
        if ((step.stopReason === 'length' || step.stopReason === 'max_tokens') && outputContinuations < MAX_OUTPUT_CONTINUATIONS) {
          outputContinuations += 1;
          options.emit({ type: 'output.continuing', attempt: outputContinuations });
          await appendMessage(options, state.messages, createContinuationMessage());
          continue;
        }
        const stopReason = finalResponseReason ?? step.stopReason;
        options.emit({ type: 'turn.completed', stopReason });
        return { messages: state.messages, stopReason };
      }

      state.toolCalls = predictedToolCalls;
      const toolProgress = await executeToolCalls(step.calls, state, options);
      if (finalResponseOnly) {
        throw new AgentError(
          finalResponseReason ?? 'no_progress',
          'The model requested another tool during the mandatory tool-free final response.'
        );
      }
      if (toolProgress.noProgressDetected && recoveryToolStepsRemaining === null) {
        recoveryToolStepsRemaining = NO_PROGRESS_RECOVERY_TOOL_STEPS;
      } else if (recoveryToolStepsRemaining !== null) {
        recoveryToolStepsRemaining -= 1;
        if (recoveryToolStepsRemaining <= 0) {
          finalResponseOnly = true;
          finalResponseReason = 'no_progress';
          await appendMessage(options, state.messages, createNoProgressFinalMessage());
        }
      }
      if (!finalResponseOnly) {
        const decision = await evaluateLoopGuards(guardContext(
          state,
          options,
          iterationBudget,
          iteration + 1,
          toolProgress.madeProgress,
          recoveryToolStepsRemaining
        ));
        if (decision.action === 'extend') {
          iterationBudget = extendIterationBudget(iterationBudget);
        } else if (decision.action === 'finalize') {
          if (options.allowPartialOnMaxIterations
            && (decision.reason === 'max_iterations' || decision.reason === 'absolute_iteration_limit')) {
            options.emit({ type: 'turn.completed', stopReason: decision.reason });
            return { messages: state.messages, stopReason: decision.reason };
          }
          finalResponseOnly = true;
          finalResponseReason = decision.reason;
          await appendMessage(
            options,
            state.messages,
            decision.reason === 'max_iterations'
              ? createIterationLimitFinalMessage(iterationBudget.currentLimit)
              : decision.reason === 'no_progress'
                ? createNoProgressFinalMessage()
                : createSafetyFinalMessage(decision.reason, iterationBudget.absoluteLimit)
          );
        } else if (decision.action === 'stop') {
          options.emit({ type: 'turn.completed', stopReason: decision.reason });
          return { messages: state.messages, stopReason: decision.reason };
        }
      }
      outputContinuations = 0;
    }

    if (options.allowPartialOnMaxIterations) {
      options.emit({ type: 'turn.completed', stopReason: iterationBudget.limitReason });
      return { messages: state.messages, stopReason: iterationBudget.limitReason };
    }
    throw new AgentError(iterationBudget.limitReason, `The turn exceeded ${iterationBudget.currentLimit} model iterations.`);
  } catch (error) {
    return handleTurnError(error, options, state.messages);
  }
}
