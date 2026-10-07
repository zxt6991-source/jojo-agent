import { describe, expect, it, vi } from 'vitest';
import type { JojoAppService, PersistedRunRecord } from '@desktop-agent/app-service';
import type { ModelProvider, PermissionGate, Tool } from '@desktop-agent/contracts';
import { ScriptedProvider } from '@desktop-agent/agent-runtime/testing';
import type { RuntimeResolutionContext } from '@desktop-agent/agent-runtime';
import type { ScheduleService } from '@desktop-agent/scheduler';

export type ApplicationHostFactory = (options: {
  provider: ModelProvider;
  permissions?: PermissionGate;
  tools?: Tool[];
}) => Promise<{
  app: JojoAppService;
  scheduler(): ScheduleService;
  executions: RuntimeResolutionContext[];
  restart(): Promise<JojoAppService>;
  persistedRun(id: string): Promise<PersistedRunRecord | undefined>;
  close(): Promise<void>;
}>;

const ctx = { requestId: 'contract', principal: { id: 'contract-user', type: 'local' as const, scopes: [] } };
const input = { laneId: 'main', providerId: 'test', model: 'test', input: { content: [{ type: 'text' as const, text: 'hello' }] } };
function textProvider() {
  return new ScriptedProvider([[{ type: 'text_delta', text: 'contract answer' }, { type: 'response_completed', stopReason: 'stop' }]]);
}

export function describeApplicationHostContract(name: string, create: ApplicationHostFactory): void {
  describe(`${name} application contract`, () => {
    it.each(['allow', 'deny', 'cancel', 'restart'] as const)('handles pending approval through the application: %s', async decision => {
      const execute = vi.fn(async () => ({ callId: 'c', ok: true, content: 'executed' }));
      const host = await create({
        provider: new ScriptedProvider([
          [{ type: 'tool_call_completed', call: { id: 'c', name: 'restricted', input: {} } }, { type: 'response_completed', stopReason: 'tool_calls' }],
          [{ type: 'text_delta', text: 'finished' }, { type: 'response_completed', stopReason: 'stop' }]
        ]),
        tools: [{ definition: { name: 'restricted', description: 'test', inputSchema: { type: 'object' } }, execute }],
        permissions: { check: async (call, context) => ({ decision: 'ask', request: {
          requestId: 'approval', sessionId: context.sessionId, call, reason: 'contract approval'
        } }) }
      });
      try {
        await host.app.createSession(ctx, { id: 's', executionScope: { kind: 'none' } });
        const handle = await host.app.startRunHandle(ctx, 's', input, { runId: 'approval-run' });
        await vi.waitFor(async () => expect(await host.app.listApprovals(ctx, 's')).toHaveLength(1));
        expect(execute).not.toHaveBeenCalled();
        expect(await host.app.getApprovalSessionId(ctx, 'approval')).toBe('s');
        expect(await host.app.listApprovals(ctx, 'other')).toEqual([]);
        expect((await host.app.getSession(ctx, 's')).pendingApprovals).toEqual([
          expect.objectContaining({ id: 'approval', sessionId: 's', laneId: 'main', runId: handle.id })
        ]);
        if (decision === 'restart') {
          const app = await host.restart();
          expect((await handle.result).status).toBe('cancelled');
          expect(await app.listApprovals(ctx, 's')).toEqual([]);
          await expect(app.resolveApproval(ctx, 'approval', 'allow')).rejects.toThrow();
          expect(execute).not.toHaveBeenCalled();
          expect(await app.getRun(ctx, 's', handle.id)).toMatchObject({ status: 'cancelled' });
        } else {
          if (decision === 'cancel') await handle.cancel('contract_cancel');
          else await host.app.resolveApproval(ctx, 'approval', decision);
          const result = await handle.result;
          expect(result.status).toBe(decision === 'cancel' ? 'cancelled' : 'completed');
          expect(execute).toHaveBeenCalledTimes(decision === 'allow' ? 1 : 0);
          expect(await host.app.listApprovals(ctx, 's')).toEqual([]);
          if (decision === 'deny') expect(result.messages.flatMap(message => message.content)).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'tool_result', result: expect.objectContaining({ ok: false, code: 'user_denied' }) })
          ]));
        }
      } finally { await host.close(); }
    });

    it('persists a scheduled Agent result and keeps its execution identity and origin across restart', async () => {
      const host = await create({ provider: textProvider() });
      try {
        await host.app.createSession(ctx, { id: 's', executionScope: { kind: 'none' } });
        const schedule = await host.scheduler().create({
          name: 'contract schedule', enabled: false,
          spec: { kind: 'once', runAt: '2099-01-01T00:00:00.000Z' },
          target: { kind: 'agent', sessionId: 's', input: input.input, providerId: input.providerId, model: input.model }
        }, { id: 'contract' });
        const started = await host.scheduler().runNow(schedule.id);
        await vi.waitFor(async () => expect(await host.scheduler().getRun(started.id)).toMatchObject({ status: 'completed' }));
        const completed = await host.scheduler().getRun(started.id);
        expect(completed.resultPreview).toBe('contract answer');
        expect(host.executions).toHaveLength(1);
        expect(host.executions[0]).toMatchObject({ runId: completed.targetExecutionId, laneId: `schedule:${schedule.id}`, trigger: { kind: 'scheduler', id: started.id } });
        expect(await host.app.getRun(ctx, 's', completed.targetExecutionId!)).toMatchObject({ status: 'completed' });
        const app = await host.restart();
        expect(await host.scheduler().getRun(started.id)).toMatchObject({ status: 'completed', targetExecutionId: completed.targetExecutionId });
        expect(await app.getRun(ctx, 's', completed.targetExecutionId!)).toMatchObject({ status: 'completed' });
        expect(host.executions).toHaveLength(1);
      } finally { await host.close(); }
    });

    it('cancels an active scheduled Agent through the application handle', async () => {
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const host = await create({ provider: { async *stream({ signal }) {
        entered();
        await new Promise<void>(resolve => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        yield { type: 'response_completed', stopReason: 'stop' };
      } } });
      try {
        await host.app.createSession(ctx, { id: 's', executionScope: { kind: 'none' } });
        const schedule = await host.scheduler().create({
          name: 'cancel schedule', enabled: false,
          spec: { kind: 'once', runAt: '2099-01-01T00:00:00.000Z' },
          target: { kind: 'agent', sessionId: 's', input: input.input, providerId: input.providerId, model: input.model }
        }, { id: 'contract' });
        const run = await host.scheduler().runNow(schedule.id);
        await started;
        expect(await host.scheduler().getRun(run.id)).toMatchObject({ status: 'running' });
        await host.scheduler().cancelRun(run.id);
        await vi.waitFor(async () => expect(await host.scheduler().getRun(run.id)).toMatchObject({ status: 'cancelled' }));
        expect(await host.app.getRun(ctx, 's', run.targetExecutionId!)).toMatchObject({ status: 'cancelled' });
        const app = await host.restart();
        expect(await host.scheduler().getRun(run.id)).toMatchObject({ status: 'cancelled' });
        expect(await app.getRun(ctx, 's', run.targetExecutionId!)).toMatchObject({ status: 'cancelled' });
        expect(host.executions).toHaveLength(1);
      } finally { await host.close(); }
    });

    it('preserves session metadata, completed run and paginated history across restart', async () => {
      const host = await create({ provider: textProvider() });
      try {
        await host.app.createSession(ctx, { id: 's', title: 'original', executionScope: { kind: 'none' } });
        await host.app.patchSession(ctx, 's', { title: 'saved', favorite: true, labels: ['contract'] });
        const result = await host.app.executeRun(ctx, 's', input, { runId: 'r', trigger: { kind: 'user' } });
        expect(result.status).toBe('completed');
        const first = await host.app.getTranscript(ctx, 's', { laneId: 'main', limit: 1 });
        expect(first.items).toHaveLength(1);
        expect(first.nextCursor).toBeDefined();
        const second = await host.app.getTranscript(ctx, 's', { laneId: 'main', limit: 1, cursor: first.nextCursor! });
        expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
        const app = await host.restart();
        expect(await app.getSession(ctx, 's')).toMatchObject({ title: 'saved', favorite: true, labels: ['contract'], activeRuns: [] });
        expect(await app.getRun(ctx, 's', 'r')).toMatchObject({ status: 'completed', result });
        expect((await app.getTranscript(ctx, 's')).items).toEqual([...first.items, ...second.items]);
      } finally { await host.close(); }
    });

    it('rejects stale metadata revisions without losing the accepted update', async () => {
      const host = await create({ provider: textProvider() });
      try {
        const session = await host.app.createSession(ctx, { id: 's', executionScope: { kind: 'none' } });
        await host.app.patchSession(ctx, 's', { title: 'winner', expectedRevision: session.revision });
        await expect(host.app.patchSession(ctx, 's', { title: 'stale', expectedRevision: session.revision })).rejects.toThrow('revision_conflict');
        expect(await host.app.getSession(ctx, 's')).toMatchObject({ title: 'winner' });
      } finally { await host.close(); }
    });

    it('cancels a live provider and persists the terminal result before returning', async () => {
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const provider: ModelProvider = { async *stream({ signal }) {
        entered();
        await new Promise<void>(resolve => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        yield { type: 'response_completed', stopReason: 'stop' };
      } };
      const host = await create({ provider });
      try {
        await host.app.createSession(ctx, { id: 's', executionScope: { kind: 'none' } });
        const handle = await host.app.startRunHandle(ctx, 's', input, { runId: 'cancelled' });
        await started;
        expect(await host.app.getRun(ctx, 's', handle.id)).toMatchObject({ status: 'running' });
        await handle.cancel('contract_cancel');
        expect((await handle.result).status).toBe('cancelled');
        expect(await host.app.getRun(ctx, 's', handle.id)).toMatchObject({ status: 'cancelled' });
        const app = await host.restart();
        expect(await app.getRun(ctx, 's', handle.id)).toMatchObject({ status: 'cancelled' });
      } finally { await host.close(); }
    });

    it('persists provider failure and permits a fresh run after restart', async () => {
      let fail = true;
      const host = await create({ provider: { async *stream() {
        if (fail) throw new Error('contract_provider_failure');
        yield { type: 'text_delta', text: 'recovered' };
        yield { type: 'response_completed', stopReason: 'stop' };
      } } });
      try {
        await host.app.createSession(ctx, { id: 's', executionScope: { kind: 'none' } });
        const failed = await host.app.executeRun(ctx, 's', input, { runId: 'failed' });
        expect(failed.status).toBe('failed');
        const app = await host.restart();
        expect(await app.getRun(ctx, 's', 'failed')).toMatchObject({ status: 'failed' });
        fail = false;
        expect((await app.executeRun(ctx, 's', input, { runId: 'fresh' })).status).toBe('completed');
        expect((await app.getSession(ctx, 's')).activeRuns).toEqual([]);
      } finally { await host.close(); }
    });

    it('rejects duplicate run IDs and cross-session reads without repeating execution', async () => {
      const host = await create({ provider: textProvider() });
      try {
        await host.app.createSession(ctx, { id: 's', executionScope: { kind: 'none' } });
        await host.app.createSession(ctx, { id: 'other', executionScope: { kind: 'none' } });
        await host.app.executeRun(ctx, 's', input, { runId: 'unique' });
        await expect(host.app.startRun(ctx, 's', input, { runId: 'unique' })).rejects.toThrow();
        await expect(host.app.getRun(ctx, 'other', 'unique')).rejects.toThrow('run_not_found');
        await expect(host.app.cancelRun(ctx, 'other', 'unique')).rejects.toThrow('run_not_found');
        await host.app.cancelRun(ctx, 's', 'unique');
        expect(host.executions).toHaveLength(1);
        const app = await host.restart();
        expect(await app.getRun(ctx, 's', 'unique')).toMatchObject({ status: 'completed' });
        expect((await app.getTranscript(ctx, 'other')).items).toEqual([]);
      } finally { await host.close(); }
    });

    it.each(['channel_message', 'workflow', 'subagent', 'team_member'] as const)('preserves %s execution origin across restart', async kind => {
      const host = await create({ provider: textProvider() });
      try {
        await host.app.createSession(ctx, { id: 's', executionScope: { kind: 'none' } });
        await host.app.executeRun(ctx, 's', input, { runId: 'origin', trigger: { kind, id: 'source' } });
        expect(host.executions[0]).toMatchObject({ runId: 'origin', trigger: { kind, id: 'source' } });
        const app = await host.restart();
        expect(await app.getRun(ctx, 's', 'origin')).toMatchObject({ status: 'completed' });
        expect(await host.persistedRun('origin')).toMatchObject({
          status: 'completed', requestMeta: { origin: { kind: kind === 'channel_message' ? 'channel' : kind } }
        });
        expect(host.executions).toHaveLength(1);
      } finally { await host.close(); }
    });

    it('does not execute a tool denied by the permission boundary', async () => {
      const execute = vi.fn(async () => ({ callId: 'c', ok: true, content: 'must not run' }));
      const host = await create({
        provider: new ScriptedProvider([
          [{ type: 'tool_call_completed', call: { id: 'c', name: 'restricted', input: {} } }, { type: 'response_completed', stopReason: 'tool_calls' }],
          [{ type: 'text_delta', text: 'denied' }, { type: 'response_completed', stopReason: 'stop' }]
        ]),
        tools: [{ definition: { name: 'restricted', description: 'test', inputSchema: { type: 'object' } }, execute }],
        permissions: { check: async () => ({ decision: 'deny', reason: 'contract hard boundary' }) }
      });
      try {
        await host.app.createSession(ctx, { id: 's', executionScope: { kind: 'none' } });
        const result = await host.app.executeRun(ctx, 's', input);
        expect(result.status).toBe('completed');
        expect(execute).not.toHaveBeenCalled();
        expect(result.messages.flatMap(message => message.content)).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: 'tool_result', result: expect.objectContaining({ ok: false }) })
        ]));
      } finally { await host.close(); }
    });
  });
}
