import { describe, expect, it, vi } from 'vitest';
import type { Message, ModelProvider, PermissionGate, Tool, ToolResult } from '@desktop-agent/contracts';
import { ScriptedProvider } from '@desktop-agent/agent';
import {
  MemoryAgentRuntimeStore,
  resumeAgentTurn,
  type OperationMeta,
  type OperationState,
  type ResumeAgentRunOptions,
  type ToolsState
} from '../src/index.js';

const time = '2026-08-20T00:00:00.000Z';
const allow: PermissionGate = { check: async () => ({ decision: 'allow' }) };
const progress = { toolCallCounts: {}, observationFingerprints: [], recoveryStepsRemaining: null };

function assistantCall(callId: string): Message {
  return {
    id: 'assistant-entry', role: 'assistant', createdAt: time,
    content: [{ type: 'tool_call', call: { id: callId, name: 'effect', input: { value: 1 } } }]
  };
}

function toolMessage(result: ToolResult): Message {
  return {
    id: 'result-entry', role: 'tool', createdAt: time,
    content: [{ type: 'tool_result', result }]
  };
}

function options(
  store: MemoryAgentRuntimeStore,
  provider: ModelProvider,
  tool: Tool,
  history: Message[]
): ResumeAgentRunOptions {
  return {
    runtimeStore: store,
    operationId: 'operation-1',
    sessionId: 'session-1',
    workingDirectory: process.cwd(),
    providerId: 'provider-1',
    model: 'model-1',
    history,
    provider,
    tools: [tool],
    permissionGate: allow,
    signal: new AbortController().signal,
    emit: () => undefined,
    approve: async () => true
  };
}

async function operationStore(state: OperationState): Promise<MemoryAgentRuntimeStore> {
  const store = new MemoryAgentRuntimeStore();
  await store.createSession({ id: 'session-1', createdAt: 1 });
  await store.saveLane({ sessionId: 'session-1', name: 'main', leafId: null, currentOperationId: null });
  const meta: OperationMeta = {
    id: 'operation-1', sessionId: 'session-1', lane: 'main', kind: 'run', createdAt: 2,
    providerId: 'provider-1', model: 'model-1', maxIterations: 12
  };
  await store.startOperation(meta, state);
  return store;
}

function pendingTool(replay: 'safe' | 'never'): ToolsState {
  return {
    phase: 'tools', operationId: 'operation-1', lane: 'main', iteration: 0,
    outputContinuations: 0, progress, assistantEntryId: 'assistant-entry', currentIndex: 0,
    noProgressDetected: false, finalResponseOnly: false,
    calls: [{
      toolIndex: 0, callId: 'call-1', toolName: 'effect', input: { value: 1 },
      resultEntryId: 'result-entry', replay, permission: 'approved', status: 'effect_pending'
    }]
  };
}

const finalProvider = () => new ScriptedProvider([[
  { type: 'text_delta', text: 'recovered' },
  { type: 'response_completed', stopReason: 'stop' }
]]);

describe('crash recovery', () => {
  it('restores the same pending approval instead of generating a new request', async () => {
    const state = pendingTool('never');
    state.calls[0] = {
      ...state.calls[0]!,
      status: 'planned',
      permission: 'pending',
      approvalRequest: {
        requestId: 'approval-original',
        sessionId: 'session-1',
        call: { id: 'call-1', name: 'effect', input: { value: 1 } },
        reason: 'Confirm external effect'
      }
    };
    const store = await operationStore(state);
    const execute = vi.fn(async () => ({ callId: '', ok: true, content: 'done' }));
    const tool: Tool = {
      definition: { name: 'effect', description: 'effect', inputSchema: { type: 'object' } },
      replay: 'never', execute
    };
    const gate = { check: vi.fn(async () => ({ decision: 'allow' as const })) };
    const approve = vi.fn(async () => true);
    const resumeOptions = options(store, finalProvider(), tool, [assistantCall('call-1')]);
    resumeOptions.permissionGate = gate;
    resumeOptions.approve = approve;

    await resumeAgentTurn(resumeOptions);

    expect(gate.check).not.toHaveBeenCalled();
    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'approval-original' }),
      resumeOptions.signal
    );
    expect(execute).toHaveBeenCalledOnce();
  });

  it('replays a safe tool whose effect was pending', async () => {
    const execute = vi.fn(async () => ({ callId: '', ok: true, content: 'checked' }));
    const tool: Tool = {
      definition: { name: 'effect', description: 'effect', inputSchema: { type: 'object' } },
      replay: 'safe', execute
    };
    const store = await operationStore(pendingTool('safe'));

    const result = await resumeAgentTurn(options(store, finalProvider(), tool, [assistantCall('call-1')]));

    expect(result.stopReason).toBe('stop');
    expect(execute).toHaveBeenCalledOnce();
    expect(result.messages.some((message) => message.role === 'tool')).toBe(true);
  });

  it('does not replay a never tool and records explicit uncertainty', async () => {
    const execute = vi.fn(async () => ({ callId: '', ok: true, content: 'sent' }));
    const tool: Tool = {
      definition: { name: 'effect', description: 'effect', inputSchema: { type: 'object' } },
      replay: 'never', execute
    };
    const store = await operationStore(pendingTool('never'));

    const result = await resumeAgentTurn(options(store, finalProvider(), tool, [assistantCall('call-1')]));
    const recovered = result.messages.flatMap((message) => message.content)
      .find((block) => block.type === 'tool_result');

    expect(execute).not.toHaveBeenCalled();
    expect(recovered?.type === 'tool_result' && recovered.result).toMatchObject({
      callId: 'call-1', ok: false, code: 'interrupted_uncertain_effect'
    });
  });

  it('never repeats an already completed tool', async () => {
    const settled = { callId: 'call-1', ok: true, content: 'already done' };
    const state = pendingTool('never');
    state.calls[0] = { ...state.calls[0]!, status: 'completed', result: settled };
    const store = await operationStore(state);
    const execute = vi.fn(async () => settled);
    const tool: Tool = {
      definition: { name: 'effect', description: 'effect', inputSchema: { type: 'object' } },
      replay: 'never', execute
    };

    await resumeAgentTurn(options(store, finalProvider(), tool, [assistantCall('call-1'), toolMessage(settled)]));

    expect(execute).not.toHaveBeenCalled();
  });

  it('retries model_pending with the reserved response id and incremented attempt', async () => {
    class RecordingStore extends MemoryAgentRuntimeStore {
      readonly states: OperationState[] = [];
      override async saveOperationState(state: OperationState): Promise<void> {
        await super.saveOperationState(state);
        this.states.push(structuredClone(state));
      }
    }
    const store = new RecordingStore();
    await store.createSession({ id: 'session-1', createdAt: 1 });
    await store.saveLane({ sessionId: 'session-1', name: 'main', leafId: null, currentOperationId: null });
    await store.startOperation({
      id: 'operation-1', sessionId: 'session-1', lane: 'main', kind: 'run', createdAt: 2,
      providerId: 'provider-1', model: 'model-1', maxIterations: 12
    }, {
      phase: 'model_pending', operationId: 'operation-1', lane: 'main', iteration: 0,
      outputContinuations: 0, progress, responseEntryId: 'reserved-response', usageId: 'reserved-usage',
      request: {
        providerId: 'provider-1', model: 'model-1', toolNames: [],
        maxOutputTokens: 1_024, finalResponseOnly: false
      },
      attempt: 1
    });
    const provider: ModelProvider = {
      async *stream() {
        expect(store.states.at(-1)).toMatchObject({ phase: 'model_pending', attempt: 2 });
        yield { type: 'text_delta', text: 'retried' };
        yield { type: 'response_completed', stopReason: 'stop' };
      }
    };
    const tool: Tool = {
      definition: { name: 'effect', description: 'effect', inputSchema: { type: 'object' } },
      replay: 'safe', execute: async () => ({ callId: '', ok: true, content: 'unused' })
    };
    const history: Message[] = [{
      id: 'user-1', role: 'user', createdAt: time, content: [{ type: 'text', text: 'resume' }]
    }];

    const result = await resumeAgentTurn(options(store, provider, tool, history));

    expect(result.messages.at(-1)).toMatchObject({ id: 'reserved-response', role: 'assistant' });
    expect(result.stopReason).toBe('stop');
  });
});
