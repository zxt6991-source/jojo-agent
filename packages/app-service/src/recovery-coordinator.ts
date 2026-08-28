import type { AgentRuntime } from '@desktop-agent/agent-runtime';
import type { ServerStateStore } from './persistence.js';

export class ServerRecoveryCoordinator {
  constructor(
    private readonly runtime: AgentRuntime,
    private readonly store: ServerStateStore
  ) {}

  async reconcile(): Promise<void> {
    await this.reconcileSessions();
    await this.reconcileApprovals();
    await this.reconcileRuns();
  }

  private async reconcileSessions(): Promise<void> {
    const runtimeSessions = await this.runtime.listSessions();
    const runtimeIds = new Set(runtimeSessions.map((session) => session.id));
    for (const metadata of await this.store.sessions.list()) {
      if (metadata.state !== 'creating') continue;
      if (runtimeIds.has(metadata.sessionId)) await this.store.sessions.activate(metadata.sessionId);
      else await this.store.sessions.deleteCreating(metadata.sessionId);
    }
    for (const session of runtimeSessions) await this.store.sessions.ensureActive({ sessionId: session.id });
  }

  private async reconcileApprovals(): Promise<void> {
    for (const approval of await this.store.approvals.listRecoverable()) {
      await this.store.approvals.interrupt(
        approval.id,
        'server_restart_without_durable_suspension',
        approval.version
      );
    }
  }

  private async reconcileRuns(): Promise<void> {
    for (const run of await this.store.runs.listRecoverable()) {
      if (run.status !== 'accepted') {
        const runtime = await this.runtime.inspectRun(run.id);
        if (runtime?.result) {
          if (runtime.result.status === 'completed') {
            await this.store.runs.markCompleted(run.id, runtime.result, run.version);
          } else if (runtime.result.status === 'cancelled') {
            await this.store.runs.markCancelled(run.id, runtime.result, run.version);
          } else {
            await this.store.runs.markFailed(run.id, {
              code: runtime.result.error?.code ?? 'runtime_internal',
              message: runtime.result.error?.message ?? 'Runtime execution failed.',
              ...(runtime.result.error?.detail !== undefined ? { details: runtime.result.error.detail } : {})
            }, runtime.result, run.version);
          }
          continue;
        }
      }
      const code = run.status === 'accepted' ? 'run_start_not_committed' : 'runtime_interrupted';
      await this.store.runs.markInterrupted(run.id, {
        code,
        message: 'Runtime execution could not be proven terminal after server restart.',
        retryable: true
      }, run.version);
    }
  }
}
