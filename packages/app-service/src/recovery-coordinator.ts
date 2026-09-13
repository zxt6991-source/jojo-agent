import type { AgentRuntime } from '@desktop-agent/agent-runtime';
import type { PersistedRunRecord, ServerStateStore } from './persistence.js';

export class ServerRecoveryCoordinator {
  constructor(
    private readonly runtime: AgentRuntime,
    private readonly store: ServerStateStore
  ) {}

  async reconcile(): Promise<void> {
    await this.reconcileSessions();
    await this.reconcileApprovals();
    const recovery = await this.runtime.recoverInterruptedOperations({ reason: 'host_restart' });
    if (!recovery.ready) throw new Error(`runtime_recovery_conflict: ${JSON.stringify(recovery.outcomes)}`);
    await this.reconcileRuns();
    if ((await this.store.runs.listRecoverable()).length || (await this.store.approvals.listRecoverable()).length) throw new Error('server_recovery_incomplete');
    for (const session of await this.runtime.listSessions()) {
      const runtimeSession = await this.runtime.getSession(session.id);
      if ((await runtimeSession!.listLanes()).some(lane => lane.activeRunId)) throw new Error('runtime_recovery_incomplete');
    }
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
      try {
        await this.reconcileRun(run);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith('run_transition_conflict')) throw error;
        const current = await this.store.runs.get(run.id);
        if (!current) throw error;
        if (['accepted', 'starting', 'running'].includes(current.status)) await this.reconcileRun(current);
      }
    }
  }

  private async reconcileRun(run: PersistedRunRecord): Promise<void> {
    const runtime = await this.runtime.inspectRun(run.id);
    if (runtime && (runtime.sessionId !== run.sessionId || runtime.laneId !== run.laneId)) {
      throw new Error('runtime_run_identity_conflict');
    }
    if (runtime && !runtime.result) throw new Error('runtime_recovery_nonterminal');
    const result = runtime?.result;
    if (!result) {
      await this.store.runs.markInterrupted(run.id, {
        code: run.status === 'accepted' ? 'run_start_not_committed' : 'runtime_interrupted',
        message: 'Runtime operation was not committed before server restart.',
        retryable: false
      }, run.version);
      return;
    }
    if (run.status === 'accepted') run = await this.store.runs.markStarting(run.id, run.version);
    const detail = result.error?.detail;
    const recovered = detail && typeof detail === 'object' && !Array.isArray(detail)
      && (detail.reason === 'host_restart' || detail.reason === 'resume_unavailable');
    if (result.error?.code === 'runtime_interrupted' && recovered) {
      await this.store.runs.markInterrupted(run.id, {
        code: 'runtime_interrupted', message: result.error.message, details: detail, retryable: false
      }, run.version);
    } else if (result.status === 'completed') {
      await this.store.runs.markCompleted(run.id, result, run.version);
    } else if (result.status === 'cancelled') {
      await this.store.runs.markCancelled(run.id, result, run.version);
    } else {
      await this.store.runs.markFailed(run.id, {
        code: result.error?.code ?? 'runtime_internal',
        message: result.error?.message ?? 'Runtime execution failed.',
        ...(detail !== undefined ? { details: detail } : {})
      }, result, run.version);
    }
  }
}
