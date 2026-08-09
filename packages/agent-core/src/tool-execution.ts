import type { Tool, ToolCall, ToolResult } from '@desktop-agent/contracts';
import { errorMessage, throwIfAborted } from './errors.js';
import type { AgentRunOptions } from './types.js';

type ToolExecutionState = {
  toolsByName: Map<string, Tool>;
  executedCallIds: Set<string>;
};

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
    return failureResult(call, decision.reason, 'permission_denied');
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
      workingDirectory: options.workingDirectory,
      signal: options.signal,
      approved: decision.decision === 'ask',
      onProgress: (text) => options.emit({ type: 'tool.progress', id: call.id, text })
    });
    return { ...result, callId: call.id };
  } catch (error) {
    if (options.signal.aborted) throw error;
    return failureResult(call, errorMessage(error), 'tool_error');
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
    result = await executeKnownTool(call, tool, options);
  }

  options.emit({ type: 'tool.finished', id: call.id, result });
  return result;
}
