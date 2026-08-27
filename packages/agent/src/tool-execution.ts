import type { Tool, ToolCall, ToolResult } from '@desktop-agent/contracts';
import { errorMessage, throwIfAborted } from './errors.js';
import { canonicalJson, normalizeObservation, sha256 } from './loop/fingerprint.js';
import { DEFAULT_AGENT_LOOP_SAFETY, type PollingCallState } from './loop/types.js';
import type { AgentRunOptions } from './types.js';

export type ToolExecutionState = {
  toolsByName: Map<string, Tool>;
  executedCallIds: Set<string>;
  toolCallCounts: Map<string, number>;
  observationFingerprints: Set<string>;
  pollingCalls: Map<string, PollingCallState>;
  repeatedToolCalls: number;
  duplicateObservations: number;
};

const INFORMATION_ONLY_TOOLS = new Set([
  'glob',
  'grep',
  'list_files',
  'load_skill',
  'mcp_tool_manifest',
  'mcp_tool_describe',
  'mcp_list_resources',
  'mcp_list_prompts',
  'read_file',
  'web_fetch',
  'web_search'
]);

function repeatedCallResult(
  call: ToolCall,
  tool: Tool,
  state: ToolExecutionState,
  options: AgentRunOptions
): ToolResult | null {
  if ((tool.repeatPolicy ?? tool.definition.repeatPolicy) === 'polling') {
    return pollingBudgetResult(call, tool, state, options);
  }
  const signature = `${call.name}:${canonicalJson(call.input)}`;
  const count = (state.toolCallCounts.get(signature) ?? 0) + 1;
  state.toolCallCounts.set(signature, count);
  if (count > 1) state.repeatedToolCalls += 1;
  const maximum = options.loopSafety?.maxIdenticalToolCalls
    ?? DEFAULT_AGENT_LOOP_SAFETY.maxIdenticalToolCalls;
  if (count <= maximum) return null;
  return failureResult(
    call,
    `This exact tool call has already run ${maximum} times in this turn. Reuse the existing results, change the approach, or explain the limitation instead of repeating it.`,
    'no_progress'
  );
}

function pollingBudgetResult(
  call: ToolCall,
  tool: Tool,
  state: ToolExecutionState,
  options: AgentRunOptions
): ToolResult | null {
  const now = Date.now();
  const signature = `${call.name}:${canonicalJson(call.input)}`;
  const previous = state.pollingCalls.get(signature);
  const next: PollingCallState = previous
    ? { count: previous.count + 1, firstAt: previous.firstAt, lastAt: now }
    : { count: 1, firstAt: now, lastAt: now };
  state.pollingCalls.set(signature, next);
  const safety = options.loopSafety ?? DEFAULT_AGENT_LOOP_SAFETY;
  const polling = tool.polling ?? tool.definition.polling;
  const maxPolls = polling?.maxPollsPerInput ?? safety.maxPollsPerInput;
  const maxDurationMs = polling?.maxDurationMs ?? safety.maxPollDurationMs;
  const minIntervalMs = polling?.minIntervalMs ?? safety.minPollIntervalMs;
  if (previous && minIntervalMs > 0 && now - previous.lastAt < minIntervalMs) {
    return failureResult(
      call,
      `Polling this input again after ${now - previous.lastAt}ms is below the ${minIntervalMs}ms minimum interval.`,
      'no_progress'
    );
  }
  if (next.count > maxPolls || now - next.firstAt > maxDurationMs) {
    return failureResult(
      call,
      `The polling budget for this tool input was exhausted (${next.count - 1}/${maxPolls} polls, ${now - next.firstAt}ms elapsed).`,
      'no_progress'
    );
  }
  return null;
}

function repeatedObservationResult(
  call: ToolCall,
  result: ToolResult,
  state: ToolExecutionState
): ToolResult {
  const observationOnly = INFORMATION_ONLY_TOOLS.has(call.name)
    || (state.toolsByName.get(call.name)?.repeatPolicy
      ?? state.toolsByName.get(call.name)?.definition.repeatPolicy) === 'idempotent-observation';
  if (!result.ok || !observationOnly) return result;
  const digest = sha256(normalizeObservation(result.content));
  const fingerprint = `${call.name}:${result.code ?? 'ok'}:${digest}`;
  if (!state.observationFingerprints.has(fingerprint)) {
    state.observationFingerprints.add(fingerprint);
    return result;
  }
  state.duplicateObservations += 1;
  return {
    ...result,
    ok: false,
    code: 'no_progress',
    content: `${result.content}\n\n[No progress: this read-only tool returned information already present in the current turn. Reuse the earlier result or change approach.]`
  };
}

function failureResult(call: ToolCall, content: string, code: string): ToolResult {
  return { callId: call.id, ok: false, content, code };
}

async function executeKnownTool(
  call: ToolCall,
  tool: Tool,
  options: AgentRunOptions
): Promise<ToolResult> {
  const decision = await options.permissionGate.check(call, {
    sessionId: options.sessionId,
    workingDirectory: options.workingDirectory,
    ...(options.executionScope ? { executionScope: options.executionScope } : {})
  });

  if (decision.decision === 'deny') {
    return failureResult(call, decision.reason, decision.code ?? 'permission_denied');
  }

  if (decision.decision === 'ask') {
    options.emit({ type: 'approval.required', request: decision.request });
    const allowed = await options.approve(decision.request, options.signal);
    if (!allowed) {
      return failureResult(call, 'The user denied this tool call.', 'user_denied');
    }
  }

  return executeApprovedTool(call, tool, options);
}

async function executeApprovedTool(
  call: ToolCall,
  tool: Tool,
  options: AgentRunOptions
): Promise<ToolResult> {
  try {
    const result = await tool.execute(call.input, {
      sessionId: options.sessionId,
      workingDirectory: options.workingDirectory,
      ...(options.executionScope ? { executionScope: options.executionScope } : {}),
      signal: options.signal,
      approved: true,
      onProgress: (text) => options.emit({ type: 'tool.progress', id: call.id, text })
    });
    return { ...result, callId: call.id };
  } catch (error) {
    if (options.signal.aborted) throw error;
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'tool_error';
    return failureResult(call, errorMessage(error), code);
  }
}

export async function executeToolCall(
  call: ToolCall,
  state: ToolExecutionState,
  options: AgentRunOptions
): Promise<ToolResult> {
  throwIfAborted(options.signal);
  options.emit({ type: 'tool.started', id: call.id, name: call.name, input: call.input });

  let result: ToolResult;
  const tool = state.toolsByName.get(call.name);

  if (state.executedCallIds.has(call.id)) {
    result = failureResult(call, 'Duplicate tool call id; execution skipped.', 'duplicate_tool_call');
  } else if (!tool) {
    result = failureResult(call, `Unknown tool: ${call.name}`, 'unknown_tool');
  } else {
    state.executedCallIds.add(call.id);
    result = repeatedCallResult(call, tool, state, options)
      ?? repeatedObservationResult(call, await executeKnownTool(call, tool, options), state);
  }

  options.emit({ type: 'tool.finished', id: call.id, result });
  return result;
}

/** Executes a tool after the runtime has durably resolved permission. */
export async function executeApprovedToolCall(
  call: ToolCall,
  state: ToolExecutionState,
  options: AgentRunOptions
): Promise<ToolResult> {
  throwIfAborted(options.signal);
  options.emit({ type: 'tool.started', id: call.id, name: call.name, input: call.input });

  let result: ToolResult;
  const tool = state.toolsByName.get(call.name);
  if (state.executedCallIds.has(call.id)) {
    result = failureResult(call, 'Duplicate tool call id; execution skipped.', 'duplicate_tool_call');
  } else if (!tool) {
    result = failureResult(call, `Unknown tool: ${call.name}`, 'unknown_tool');
  } else {
    state.executedCallIds.add(call.id);
    result = repeatedCallResult(call, tool, state, options)
      ?? repeatedObservationResult(call, await executeApprovedTool(call, tool, options), state);
  }

  options.emit({ type: 'tool.finished', id: call.id, result });
  return result;
}
