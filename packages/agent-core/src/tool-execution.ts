import { createHash } from 'node:crypto';
import type { Tool, ToolCall, ToolResult } from '@desktop-agent/contracts';
import { errorMessage, throwIfAborted } from './errors.js';
import type { AgentRunOptions } from './types.js';

type ToolExecutionState = {
  toolsByName: Map<string, Tool>;
  executedCallIds: Set<string>;
  toolCallCounts: Map<string, number>;
  observationFingerprints: Set<string>;
};

const MAX_IDENTICAL_TOOL_CALLS = 2;
const INFORMATION_ONLY_TOOLS = new Set([
  'glob',
  'grep',
  'list_files',
  'load_skill',
  'mcp_tool_manifest',
  'mcp_tool_describe',
  'mcp_list_resources',
  'mcp_list_prompts',
  'read_file'
]);

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
}

function repeatedCallResult(call: ToolCall, state: ToolExecutionState): ToolResult | null {
  const signature = `${call.name}:${canonicalJson(call.input)}`;
  const count = (state.toolCallCounts.get(signature) ?? 0) + 1;
  state.toolCallCounts.set(signature, count);
  if (count <= MAX_IDENTICAL_TOOL_CALLS) return null;
  return failureResult(
    call,
    'This exact tool call has already run twice in this turn. Reuse the existing results, change the approach, or explain the limitation instead of repeating it.',
    'no_progress'
  );
}

function repeatedObservationResult(
  call: ToolCall,
  result: ToolResult,
  state: ToolExecutionState
): ToolResult {
  if (!result.ok || !INFORMATION_ONLY_TOOLS.has(call.name)) return result;
  const digest = createHash('sha256').update(result.content).digest('hex');
  const fingerprint = `${call.name}:${result.code ?? 'ok'}:${digest}`;
  if (!state.observationFingerprints.has(fingerprint)) {
    state.observationFingerprints.add(fingerprint);
    return result;
  }
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
    workingDirectory: options.workingDirectory
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

  try {
    const result = await tool.execute(call.input, {
      sessionId: options.sessionId,
      workingDirectory: options.workingDirectory,
      signal: options.signal,
      approved: decision.decision === 'ask',
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
    result = repeatedCallResult(call, state)
      ?? repeatedObservationResult(call, await executeKnownTool(call, tool, options), state);
  }

  options.emit({ type: 'tool.finished', id: call.id, result });
  return result;
}
