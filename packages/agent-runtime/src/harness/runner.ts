import type { Message, Tool, ToolCall, ToolDefinition, ToolResult } from '@desktop-agent/contracts';
import {
  AgentError,
  appendMessage,
  createAssistantMessage,
  createContinuationMessage,
  createNoProgressFinalMessage,
  createToolMessage,
  createUserMessage,
  errorMessage,
  executeApprovedToolCall,
  isAbortError,
  prepareModelContext,
  runModelStep,
  throwIfAborted,
  type AgentRunOptions,
  type AgentRunResult,
  type ToolExecutionState
} from '@desktop-agent/agent';
import { MemoryAgentRuntimeStore } from '../memory-store.js';
import { DefaultContextBuilder } from '../context/builder.js';
import { defaultAgentInterpreter } from '../operation/interpreter.js';
import {
  advanceTool,
  beginModelRequest,
  continueOutput,
  createReadyState,
  enterFinalResponse,
  planToolCalls,
  prepareToolEffect,
  resolveToolPermission,
  settleToolWithoutEffect,
  settleToolEffect
} from '../operation/reducer.js';
import { assertOperationState } from '../operation/invariants.js';
import { isTerminalState, type OperationState, type ToolsState } from '../operation/state.js';
import type { AgentRuntimeStore } from '../store.js';
import type { JsonValue } from '../session/types.js';

type CoreAgentRunOptions = AgentRunOptions;

export type RuntimeAgentRunOptions = CoreAgentRunOptions & {
  runtimeStore?: AgentRuntimeStore;
  providerId?: string;
  lane?: string;
  parentLane?: string;
  operationId?: string;
  sessionMetadata?: Record<string, JsonValue>;
};

export type ResumeAgentRunOptions = Omit<RuntimeAgentRunOptions, 'userText' | 'runtimeStore' | 'operationId'> & {
  runtimeStore: AgentRuntimeStore;
  operationId: string;
};

const DEFAULT_MAX_ITERATIONS = 12;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
const MAX_OUTPUT_CONTINUATIONS = 2;

type RunnerData = ToolExecutionState & {
  messages: Message[];
  toolDefinitions: ToolDefinition[];
};

const defaultContextBuilder = new DefaultContextBuilder();

function currentTools(options: RuntimeAgentRunOptions): Tool[] {
  const contextWindowTokens = options.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const tools = [...options.tools, ...(options.getTools?.({ contextWindowTokens, maxOutputTokens }) ?? [])];
  return [...new Map(tools.map((tool) => [tool.definition.name, tool])).values()];
}

function refreshTools(data: RunnerData, options: RuntimeAgentRunOptions, disabled: boolean): void {
  const tools = disabled ? [] : currentTools(options);
  data.toolsByName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  data.toolDefinitions = tools.map((tool) => tool.definition);
}

function createRunnerData(options: RuntimeAgentRunOptions): RunnerData {
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

function replayPolicy(data: RunnerData, toolName: string): 'safe' | 'never' {
  return data.toolsByName.get(toolName)?.replay ?? 'never';
}

function toolCall(state: ToolsState, callId: string): ToolCall {
  const call = state.calls[state.currentIndex];
  if (!call || call.callId !== callId) throw new AgentError('operation_corrupted', `Unexpected tool call ${callId}.`);
  return { id: call.callId, name: call.toolName, input: call.input };
}

async function appendInterruptedResults(
  state: OperationState,
  data: RunnerData,
  options: RuntimeAgentRunOptions,
  runtimeStore: AgentRuntimeStore
): Promise<void> {
  if (state.phase !== 'tools') return;
  for (const call of state.calls) {
    if (call.status === 'completed') continue;
    const result: ToolResult = {
      callId: call.callId,
      ok: false,
      code: 'cancelled',
      content: 'Tool execution was interrupted before a result was recorded.'
    };
    await appendDurableMessage(
      options,
      data,
      runtimeStore,
      state,
      createToolMessage(result, call.resultEntryId)
    );
    options.emit({ type: 'tool.finished', id: call.callId, result });
  }
}

async function saveLaneLeaf(
  store: AgentRuntimeStore,
  sessionId: string,
  laneName: string,
  leafId: string,
  operationId: string
): Promise<void> {
  const lane = await store.getLane(sessionId, laneName);
  if (!lane) throw new AgentError('operation_corrupted', `Lane not found: ${laneName}`);
  await store.saveLane({ ...lane, leafId, currentOperationId: operationId });
}

async function appendDurableMessage(
  options: RuntimeAgentRunOptions,
  data: RunnerData,
  store: AgentRuntimeStore,
  state: OperationState,
  message: Message
): Promise<void> {
  await appendMessage(options, data.messages, message);
  if (!await store.getEntry(message.id)) {
    const lane = await store.getLane(options.sessionId, state.lane);
    if (!lane) throw new AgentError('operation_corrupted', `Lane not found: ${state.lane}`);
    await store.appendEntry({
      id: message.id,
      sessionId: options.sessionId,
      parentId: lane.leafId,
      type: 'message',
      message
    });
  }
  await saveLaneLeaf(store, options.sessionId, state.lane, message.id, state.operationId);
}

async function bootstrapHistory(
  store: AgentRuntimeStore,
  sessionId: string,
  laneName: string,
  operationId: string,
  history: Message[]
): Promise<void> {
  let lane = await store.getLane(sessionId, laneName);
  if (!lane) throw new AgentError('operation_corrupted', `Lane not found: ${laneName}`);
  if (lane.leafId !== null) return;
  for (const message of history) {
    if (!await store.getEntry(message.id)) {
      await store.appendEntry({
        id: message.id,
        sessionId,
        parentId: lane.leafId,
        type: 'message',
        message
      });
    }
    lane = { ...lane, leafId: message.id, currentOperationId: operationId };
    await store.saveLane(lane);
  }
}

function completedState(
  state: OperationState,
  stopReason: string,
  finalEntryId: string | null
): OperationState {
  return {
    phase: 'completed', operationId: state.operationId, lane: state.lane,
    stopReason, finalEntryId
  };
}

function failedState(state: OperationState, error: unknown): OperationState {
  return {
    phase: 'failed', operationId: state.operationId, lane: state.lane,
    error: {
      code: error instanceof AgentError ? error.code : 'provider_error',
      message: errorMessage(error)
    }
  };
}

/**
 * Interpreter-driven runner. Every effect intent and settlement is written to
 * the injected RuntimeStore; omitting it preserves compatibility through an
 * operation-scoped memory store.
 */
async function executeAgentTurn(options: RuntimeAgentRunOptions, resuming: boolean): Promise<AgentRunResult> {
  const data = createRunnerData(options);
  const runtimeStore = options.runtimeStore ?? new MemoryAgentRuntimeStore();
  const operationId = options.operationId ?? crypto.randomUUID();
  let laneName = options.lane ?? 'main';
  let maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  let state: OperationState;
  let operationStarted: boolean;

  if (resuming) {
    const operation = await runtimeStore.loadOperation(operationId);
    if (!operation) throw new AgentError('operation_corrupted', `Operation not found: ${operationId}`);
    if (operation.meta.sessionId !== options.sessionId) {
      throw new AgentError('operation_corrupted', 'The operation belongs to a different session.');
    }
    if (operation.meta.model !== options.model) {
      throw new AgentError('provider_unavailable', `The persisted model is unavailable: ${operation.meta.model}`);
    }
    if (options.providerId && operation.meta.providerId !== options.providerId) {
      throw new AgentError('provider_unavailable', `The persisted provider is unavailable: ${operation.meta.providerId}`);
    }
    state = operation.state;
    laneName = operation.meta.lane;
    maxIterations = operation.meta.maxIterations;
    operationStarted = true;
  } else {
    state = createReadyState(operationId, laneName);
    operationStarted = false;
    if (!await runtimeStore.getSession(options.sessionId)) {
      await runtimeStore.createSession({
        id: options.sessionId,
        createdAt: Date.now(),
        ...(options.sessionMetadata ? { metadata: options.sessionMetadata } : {})
      });
    }
    if (!await runtimeStore.getLane(options.sessionId, laneName)) {
      let leafId: string | null = null;
      if (options.parentLane) {
        const parentLane = await runtimeStore.getLane(options.sessionId, options.parentLane);
        if (!parentLane) {
          throw new AgentError('operation_corrupted', `Parent lane not found: ${options.parentLane}`);
        }
        leafId = parentLane.leafId;
      }
      await runtimeStore.saveLane({
        sessionId: options.sessionId,
        name: laneName,
        leafId,
        currentOperationId: null
      });
    }
    await runtimeStore.startOperation({
      id: operationId,
      sessionId: options.sessionId,
      lane: laneName,
      kind: 'run',
      createdAt: Date.now(),
      providerId: options.providerId ?? 'compatibility',
      model: options.model,
      maxIterations
    }, state);
    operationStarted = true;
  }

  if ('progress' in state) {
    data.toolCallCounts = new Map(Object.entries(state.progress.toolCallCounts));
    data.observationFingerprints = new Set(state.progress.observationFingerprints);
  }
  if (state.phase === 'tools') {
    data.executedCallIds = new Set(
      state.calls.filter((call) => call.status === 'completed').map((call) => call.callId)
    );
  }
  const uncertainEffectCallIds = new Set(
    state.phase === 'tools'
      ? state.calls.filter((call) => call.status === 'effect_pending').map((call) => call.callId)
      : []
  );
  await bootstrapHistory(runtimeStore, options.sessionId, laneName, operationId, options.history);

  const transition = async <State extends OperationState>(next: State): Promise<State> => {
    await runtimeStore.saveOperationState(next);
    return next;
  };

  options.emit({ type: 'turn.started', sessionId: options.sessionId, turnId: operationId });

  try {
    if (!resuming) {
      await appendDurableMessage(
        options,
        data,
        runtimeStore,
        state,
        createUserMessage(options.userText, options.userImages)
      );
    }

    if (isTerminalState(state)) {
      if (state.phase === 'completed') return { messages: data.messages, stopReason: state.stopReason };
      if (state.phase === 'aborted') return { messages: data.messages, stopReason: state.reason };
      throw new AgentError(state.error.code, state.error.message);
    }

    while (!isTerminalState(state)) {
      throwIfAborted(options.signal);
      assertOperationState(state);
      const pendingRecoveryCall = state.phase === 'tools' ? state.calls[state.currentIndex] : undefined;
      const action = defaultAgentInterpreter.peekAction(state, {
        maxIterations,
        recovering: Boolean(pendingRecoveryCall && uncertainEffectCallIds.has(pendingRecoveryCall.callId))
      });
      if (!action) throw new AgentError('operation_corrupted', `No action is available for ${state.phase}.`);

      if (action.type === 'finish') {
        if (options.allowPartialOnMaxIterations) {
          state = await transition(completedState(state, 'max_iterations', null));
          options.emit({ type: 'turn.completed', stopReason: 'max_iterations' });
          continue;
        }
        throw new AgentError('max_iterations', `The turn exceeded ${maxIterations} model iterations.`);
      }

      if (action.type === 'request_model' || action.type === 'request_model_without_tools') {
        const finalResponseOnly = action.type === 'request_model_without_tools';
        if (state.phase === 'checkpoint' && finalResponseOnly) {
          await appendDurableMessage(options, data, runtimeStore, state, createNoProgressFinalMessage());
          state = await transition(enterFinalResponse(state, 'no_progress'));
        }

        refreshTools(data, options, finalResponseOnly);
        const contextWindowTokens = options.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
        const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
        const lane = await runtimeStore.getLane(options.sessionId, state.lane);
        if (!lane) throw new AgentError('operation_corrupted', `Lane not found: ${state.lane}`);
        const projection = await defaultContextBuilder.build({ store: runtimeStore, leafId: lane.leafId });
        const context = await prepareModelContext({
          messages: projection.messages,
          tools: data.toolDefinitions,
          contextWindowTokens,
          maxOutputTokens,
          ...(options.summarize ? { summarize: options.summarize } : {}),
          signal: options.signal
        });
        options.emit({
          type: 'context.updated', estimatedTokens: context.estimatedTokens, contextWindowTokens,
          compactedMessages: context.compactedMessages,
          reclaimedToolCharacters: context.reclaimedToolCharacters
        });
        if (context.compaction) {
          const compactionId = `comp_${crypto.randomUUID()}`;
          await runtimeStore.appendEntry({
            id: compactionId,
            sessionId: options.sessionId,
            parentId: lane.leafId,
            type: 'compaction',
            summary: context.compaction.summary,
            retainedTail: context.compaction.retainedTail,
            tokensBefore: context.compaction.tokensBefore
          });
          await saveLaneLeaf(runtimeStore, options.sessionId, state.lane, compactionId, state.operationId);
        }

        if (state.phase !== 'model_pending') {
          if (state.phase !== 'ready' && state.phase !== 'checkpoint' && state.phase !== 'final_response') {
            throw new AgentError('operation_corrupted', `Cannot request a model from ${state.phase}.`);
          }
          state = await transition(beginModelRequest(state, {
            responseEntryId: crypto.randomUUID(),
            usageId: crypto.randomUUID(),
            providerId: options.providerId ?? 'compatibility',
            model: options.model,
            toolNames: data.toolDefinitions.map((tool) => tool.name),
            maxOutputTokens,
            finalResponseOnly
          }));
        } else if (resuming) {
          state = await transition(beginModelRequest(state, {
            responseEntryId: state.responseEntryId,
            usageId: state.usageId,
            providerId: state.request.providerId,
            model: state.request.model,
            toolNames: state.request.toolNames,
            maxOutputTokens: state.request.maxOutputTokens,
            finalResponseOnly: state.request.finalResponseOnly
          }));
        }

        const pending = state;
        const step = await runModelStep({
          model: options.model,
          messages: context.messages,
          toolDefinitions: data.toolDefinitions,
          ...(options.instructions?.length ? { instructions: options.instructions } : {}),
          provider: options.provider,
          signal: options.signal,
          emit: options.emit,
          maxOutputTokens
        });
        await appendDurableMessage(
          options,
          data,
          runtimeStore,
          pending,
          createAssistantMessage(step.text, step.calls, pending.responseEntryId)
        );

        if (step.calls.length === 0) {
          if (
            (step.stopReason === 'length' || step.stopReason === 'max_tokens')
            && pending.outputContinuations < MAX_OUTPUT_CONTINUATIONS
          ) {
            options.emit({ type: 'output.continuing', attempt: pending.outputContinuations + 1 });
            await appendDurableMessage(options, data, runtimeStore, pending, createContinuationMessage());
            state = await transition(continueOutput(pending, pending.request.finalResponseOnly));
          } else {
            state = await transition(completedState(pending, step.stopReason, pending.responseEntryId));
            options.emit({ type: 'turn.completed', stopReason: step.stopReason });
          }
          continue;
        }

        if (pending.request.finalResponseOnly) {
          throw new AgentError(
            'no_progress',
            'The model requested another tool after tool use was paused for lack of progress.'
          );
        }
        state = await transition(planToolCalls(
          pending,
          pending.responseEntryId,
          step.calls,
          (toolName) => replayPolicy(data, toolName),
          () => crypto.randomUUID()
        ));
        continue;
      }

      if (state.phase !== 'tools') {
        throw new AgentError('operation_corrupted', `Action ${action.type} requires tools state.`);
      }

      if (action.type === 'prepare_tool_effect') {
        state = await transition(prepareToolEffect(state, action.callId));
        continue;
      }

      if (action.type === 'request_approval') {
        const call = toolCall(state, action.callId);
        const callState = state.calls[state.currentIndex]!;
        if (!callState.approvalRequest) {
          const decision = await options.permissionGate.check(call, {
            sessionId: options.sessionId,
            workingDirectory: options.workingDirectory
          });
          if (decision.decision === 'allow') {
            state = await transition(resolveToolPermission(state, call.id, 'not_required'));
            continue;
          }
          if (decision.decision === 'deny') {
            const result: ToolResult = {
              callId: call.id,
              ok: false,
              code: decision.code ?? 'permission_denied',
              content: decision.reason
            };
            await appendDurableMessage(
              options, data, runtimeStore, state, createToolMessage(result, callState.resultEntryId)
            );
            options.emit({ type: 'tool.finished', id: call.id, result });
            state = await transition(settleToolWithoutEffect(state, call.id, result));
            continue;
          }
          state = await transition(resolveToolPermission(state, call.id, 'pending', decision.request));
        }

        const request = state.calls[state.currentIndex]!.approvalRequest;
        if (!request) throw new AgentError('operation_corrupted', `Approval request missing for ${call.id}.`);
        options.emit({ type: 'approval.required', request });
        const approved = await options.approve(request, options.signal);
        if (approved) {
          state = await transition(resolveToolPermission(state, call.id, 'approved', request));
        } else {
          const result: ToolResult = {
            callId: call.id,
            ok: false,
            code: 'user_denied',
            content: 'The user denied this tool call.'
          };
          await appendDurableMessage(
            options, data, runtimeStore, state, createToolMessage(result, callState.resultEntryId)
          );
          options.emit({ type: 'tool.finished', id: call.id, result });
          state = await transition(settleToolWithoutEffect(state, call.id, result));
        }
        continue;
      }

      if (action.type === 'execute_tool') {
        const call = toolCall(state, action.callId);
        const result = await executeApprovedToolCall(call, data, options);
        const resultEntryId = state.calls[state.currentIndex]!.resultEntryId;
        await appendDurableMessage(options, data, runtimeStore, state, createToolMessage(result, resultEntryId));
        let settled = settleToolEffect(state, call.id, result);
        if (result.code === 'no_progress') settled = { ...settled, noProgressDetected: true };
        state = await transition(settled);
        uncertainEffectCallIds.delete(call.id);
        continue;
      }

      if (action.type === 'synthesize_interrupted_tool_result') {
        const call = toolCall(state, action.callId);
        const result: ToolResult = {
          callId: call.id,
          ok: false,
          code: 'interrupted_uncertain_effect',
          content: 'The previous process stopped while this tool effect was pending. The effect may already have occurred, so the runtime did not replay it automatically.'
        };
        const resultEntryId = state.calls[state.currentIndex]!.resultEntryId;
        await appendDurableMessage(options, data, runtimeStore, state, createToolMessage(result, resultEntryId));
        options.emit({ type: 'tool.finished', id: call.id, result });
        state = await transition(settleToolEffect(state, call.id, result));
        uncertainEffectCallIds.delete(call.id);
        continue;
      }

      if (action.type === 'advance_tool') {
        state = await transition(advanceTool(state));
        continue;
      }

      throw new AgentError('operation_corrupted', `Action ${action.type} is not implemented by the runtime runner.`);
    }

    if (state.phase === 'completed') return { messages: data.messages, stopReason: state.stopReason };
    throw new AgentError(state.phase === 'failed' ? state.error.code : 'operation_corrupted', 'Operation did not complete.');
  } catch (error) {
    if (options.signal.aborted || isAbortError(error)) {
      await appendInterruptedResults(state, data, options, runtimeStore);
      state = await transition({ phase: 'aborted', operationId: state.operationId, lane: state.lane, reason: 'cancelled' });
      options.emit({ type: 'turn.cancelled' });
      return { messages: data.messages, stopReason: 'cancelled' };
    }

    const failed = failedState(state, error);
    state = failed;
    if (operationStarted) {
      try { await runtimeStore.saveOperationState(failed); } catch { /* preserve the original failure */ }
    }
    options.emit({
      type: 'turn.failed',
      code: state.phase === 'failed' ? state.error.code : 'agent_error',
      message: errorMessage(error)
    });
    throw error;
  }
}

export function runAgentTurn(options: RuntimeAgentRunOptions): Promise<AgentRunResult> {
  return executeAgentTurn(options, false);
}

export function resumeAgentTurn(options: ResumeAgentRunOptions): Promise<AgentRunResult> {
  return executeAgentTurn({ ...options, userText: '' }, true);
}
