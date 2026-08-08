import type {
  AgentEvent,
  ApprovalRequest,
  Message,
  ModelEvent,
  ModelProvider,
  PermissionGate,
  Tool,
  ToolCall,
  ToolResult
} from '@desktop-agent/contracts';

export type AgentRunOptions = {
  sessionId: string;
  workingDirectory: string;
  model: string;
  history: Message[];
  userText: string;
  provider: ModelProvider;
  tools: Tool[];
  permissionGate: PermissionGate;
  signal: AbortSignal;
  maxIterations?: number;
  emit: (event: AgentEvent) => void;
  approve: (request: ApprovalRequest, signal: AbortSignal) => Promise<boolean>;
  commitMessage?: (message: Message) => Promise<void>;
};

export type AgentRunResult = { messages: Message[]; stopReason: string };

const createId = () => crypto.randomUUID();
const now = () => new Date().toISOString();

class AgentError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

async function commit(options: AgentRunOptions, messages: Message[], message: Message): Promise<void> {
  messages.push(message);
  await options.commitMessage?.(message);
}

function aborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('The turn was cancelled.', 'AbortError');
}

function resultFor(call: ToolCall, ok: boolean, content: string, code?: string): ToolResult {
  return { callId: call.id, ok, content, ...(code ? { code } : {}) };
}

export async function runAgentTurn(options: AgentRunOptions): Promise<AgentRunResult> {
  const turnId = createId();
  const messages = [...options.history];
  const tools = new Map(options.tools.map((tool) => [tool.definition.name, tool]));
  const executedCallIds = new Set<string>();
  const maxIterations = options.maxIterations ?? 8;
  options.emit({ type: 'turn.started', sessionId: options.sessionId, turnId });

  const userMessage: Message = {
    id: createId(), role: 'user', createdAt: now(), content: [{ type: 'text', text: options.userText }]
  };

  try {
    await commit(options, messages, userMessage);
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      aborted(options.signal);
      let text = '';
      let stopReason = 'stop';
      const calls: ToolCall[] = [];
      let receivedEvent = false;

      for await (const event of options.provider.stream({
        model: options.model,
        messages,
        tools: options.tools.map((tool) => tool.definition),
        signal: options.signal
      })) {
        receivedEvent = true;
        aborted(options.signal);
        if (event.type === 'text_delta') {
          text += event.text;
          options.emit({ type: 'text.delta', text: event.text });
        } else if (event.type === 'tool_call_completed') {
          calls.push(event.call);
        } else if (event.type === 'usage') {
          options.emit({
            type: 'usage',
            ...(event.inputTokens !== undefined ? { inputTokens: event.inputTokens } : {}),
            ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {})
          });
        } else if (event.type === 'response_completed') {
          stopReason = event.stopReason;
        } else if (event.type === 'response_failed') {
          throw new AgentError(event.code, event.message);
        }
      }
      if (!receivedEvent) throw new AgentError('empty_response', 'The provider returned no events.');

      const assistantMessage: Message = {
        id: createId(), role: 'assistant', createdAt: now(), content: [
          ...(text ? [{ type: 'text' as const, text }] : []),
          ...calls.map((call) => ({ type: 'tool_call' as const, call }))
        ]
      };
      await commit(options, messages, assistantMessage);

      if (calls.length === 0) {
        options.emit({ type: 'turn.completed', stopReason });
        return { messages, stopReason };
      }

      for (const call of calls) {
        aborted(options.signal);
        options.emit({ type: 'tool.started', id: call.id, name: call.name, input: call.input });
        let result: ToolResult;
        const tool = tools.get(call.name);
        if (executedCallIds.has(call.id)) {
          result = resultFor(call, false, 'Duplicate tool call id; execution skipped.', 'duplicate_tool_call');
        } else if (!tool) {
          result = resultFor(call, false, `Unknown tool: ${call.name}`, 'unknown_tool');
        } else {
          executedCallIds.add(call.id);
          const decision = await options.permissionGate.check(call, {
            sessionId: options.sessionId,
            workingDirectory: options.workingDirectory
          });
          if (decision.decision === 'deny') {
            result = resultFor(call, false, decision.reason, 'permission_denied');
          } else {
            let allowed = true;
            if (decision.decision === 'ask') {
              options.emit({ type: 'approval.required', request: decision.request });
              allowed = await options.approve(decision.request, options.signal);
            }
            if (!allowed) {
              result = resultFor(call, false, 'The user denied this tool call.', 'user_denied');
            } else {
              try {
                result = await tool.execute(call.input, {
                  workingDirectory: options.workingDirectory,
                  signal: options.signal,
                  approved: decision.decision === 'ask',
                  onProgress: (progressText) => options.emit({ type: 'tool.progress', id: call.id, text: progressText })
                });
                result = { ...result, callId: call.id };
              } catch (error) {
                if (options.signal.aborted) throw error;
                result = resultFor(call, false, error instanceof Error ? error.message : String(error), 'tool_error');
              }
            }
          }
        }
        options.emit({ type: 'tool.finished', id: call.id, result });
        await commit(options, messages, {
          id: createId(), role: 'tool', createdAt: now(), content: [{ type: 'tool_result', result }]
        });
      }
    }
    throw new AgentError('max_iterations', `The turn exceeded ${maxIterations} model iterations.`);
  } catch (error) {
    if (options.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      options.emit({ type: 'turn.cancelled' });
      return { messages, stopReason: 'cancelled' };
    }
    const code = error instanceof AgentError ? error.code : 'agent_error';
    const message = error instanceof Error ? error.message : String(error);
    options.emit({ type: 'turn.failed', code, message });
    throw error;
  }
}

export class ScriptedProvider implements ModelProvider {
  private index = 0;
  constructor(private readonly scripts: ModelEvent[][]) {}
  async *stream(): AsyncIterable<ModelEvent> {
    const script = this.scripts[this.index++] ?? [];
    for (const event of script) yield event;
  }
}
