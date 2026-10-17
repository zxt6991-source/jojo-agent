import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAgentRuntime, type RuntimeResolutionContext } from '@desktop-agent/agent-runtime';
import { createTestExecutionSnapshot, describeTestProvider, ScriptedProvider } from '@desktop-agent/agent-runtime/testing';
import { createJojoAppService } from '@desktop-agent/app-service';
import { BUILD_COMPATIBILITY } from '@desktop-agent/contracts/build-compatibility';
import type { ApplicationContext } from '@desktop-agent/contracts/application';
import { describe, expect, it } from 'vitest';
import { SqliteAgentRuntimeStore } from '../src/sqlite-runtime-store.js';
import { SqliteServerStateStore } from '../src/sqlite-server-state-store.js';

const context: ApplicationContext = { requestId: 'voice-test', principal: { id: 'local', type: 'local', scopes: [] } };
const voice = { voiceTurnId: 'voice-durable', generation: 3 };
const request = { laneId: 'main', providerId: 'p', model: 'm', input: { content: [{ type: 'text' as const, text: 'voice sentence' }] } };
function environment(contexts: RuntimeResolutionContext[]) {
  return { host: { kind: 'test' as const },
    providers: { describe: describeTestProvider, resolve: (ctx: RuntimeResolutionContext) => {
      contexts.push(ctx); return new ScriptedProvider([[{ type: 'text_delta', text: 'done' }, { type: 'response_completed', stopReason: 'stop' }]]);
    } },
    tools: { resolve: (ctx: RuntimeResolutionContext) => { contexts.push(ctx); return { snapshot: () => [] }; } },
    permissions: { check: async () => ({ decision: 'allow' as const }) }
  };
}

describe('SQLite voice Run provenance', () => {
  it('reopens application origin, execution and user-message metadata without changing database versions', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'voice-run-durable-'));
    const runtimeFile = path.join(directory, 'runtime.sqlite'); const applicationFile = path.join(directory, 'application.sqlite');
    const store = new SqliteAgentRuntimeStore(runtimeFile); const stateStore = new SqliteServerStateStore(applicationFile); const contexts: RuntimeResolutionContext[] = [];
    const runtime = createAgentRuntime({ store, environment: environment(contexts) }); const app = createJojoAppService(runtime, { stateStore });
    try {
      await app.openSession(context, { id: 's', executionScope: { kind: 'none' } });
      const result = await app.executeRun(context, 's', request, { runId: 'voice-run', actor: { kind: 'main' }, trigger: { kind: 'user' }, metadata: { voice } });
      expect(result.status).toBe('completed'); for (const ctx of contexts) expect(ctx).toMatchObject({ actor: { kind: 'main' }, trigger: { kind: 'user' }, voice });
    } finally { await app.close(); store.close(); }
    const reopened = new SqliteAgentRuntimeStore(runtimeFile); const restoredState = new SqliteServerStateStore(applicationFile);
    try {
      expect((await restoredState.runs.get('voice-run'))?.requestMeta?.origin).toEqual({ kind: 'user', voice });
      expect((await reopened.loadOperation('voice-run'))?.meta.execution).toMatchObject({ actor: { kind: 'main' }, trigger: { kind: 'user' }, voice });
      const messages = reopened.readConversationMessages('s'); expect(messages.filter(message => message.role === 'user')).toHaveLength(1);
      expect(messages.find(message => message.role === 'user')?.metadata?.voice).toEqual(voice);
      for (const [file, expected] of [[runtimeFile, BUILD_COMPATIBILITY.runtimeSqliteSchema], [applicationFile, BUILD_COMPATIBILITY.serverStateSchema]] as const) {
        const database = new DatabaseSync(file, { readOnly: true });
        try { expect(database.prepare('PRAGMA user_version').get()?.user_version).toBe(expected); } finally { database.close(); }
      }
    } finally { reopened.close(); await restoredState.close(); await rm(directory, { recursive: true, force: true }); }
  });
  it('recovers a voice checkpoint after reopening and preserves a single original user message', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'voice-run-resume-')); const file = path.join(directory, 'runtime.sqlite');
    const store = new SqliteAgentRuntimeStore(file);
    await store.createSession({ id: 's', createdAt: 1 });
    await store.appendEntry({ id: 'original-user', sessionId: 's', parentId: null, type: 'message',
      message: { id: 'original-user', role: 'user', createdAt: '2026-01-01T00:00:00.000Z', content: [{ type: 'text', text: 'voice sentence' }], metadata: { voice } } });
    await store.saveLane({ sessionId: 's', name: 'main', leafId: 'original-user', currentOperationId: null });
    await store.startOperation({ id: 'voice-run', sessionId: 's', lane: 'main', kind: 'run', createdAt: 2, providerId: 'p', model: 'm', maxIterations: 12,
      execution: createTestExecutionSnapshot({ actor: { kind: 'main' }, trigger: { kind: 'user' }, voice, providerBinding: describeTestProvider({ providerId: 'p', model: 'm' }) }) },
    { phase: 'checkpoint', operationId: 'voice-run', lane: 'main', iteration: 1, outputContinuations: 0,
      progress: { toolCallCounts: {}, observationFingerprints: [], recoveryStepsRemaining: null } });
    store.close();
    const reopened = new SqliteAgentRuntimeStore(file); const contexts: RuntimeResolutionContext[] = [];
    const runtime = createAgentRuntime({ store: reopened, environment: environment(contexts) });
    try {
      const result = await (await runtime.resumeOperation({ operationId: 'voice-run' })).result;
      expect(result.status).toBe('completed'); expect(result.messages.filter(message => message.role === 'user')).toHaveLength(1);
      expect(result.messages.find(message => message.role === 'user')?.metadata?.voice).toEqual(voice);
      expect((await runtime.inspectRun('voice-run'))?.execution).toMatchObject({ voice, actor: { kind: 'main' }, trigger: { kind: 'user' } });
      for (const ctx of contexts) expect(ctx).toMatchObject({ voice, actor: { kind: 'main' }, trigger: { kind: 'user' } });
    } finally { await runtime.close(); reopened.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
