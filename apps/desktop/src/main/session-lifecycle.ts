export type SessionLifecycleState = 'active' | 'deleting' | 'deleted';

export class SessionLifecycleError extends Error {
  readonly code: 'session_deleting' | 'session_unavailable';

  constructor(sessionId: string, state: Exclude<SessionLifecycleState, 'active'>) {
    const code = state === 'deleting' ? 'session_deleting' : 'session_unavailable';
    super(`${code}: Session ${sessionId} is ${state}.`);
    this.name = 'SessionLifecycleError';
    this.code = code;
  }
}

export type SessionDeleteLease = {
  commit(): void;
  rollback(): void;
};

/** Main-process authority for starting new session-scoped mutations. */
export class SessionLifecycleManager {
  private readonly states = new Map<string, SessionLifecycleState>();

  state(sessionId: string): SessionLifecycleState {
    return this.states.get(sessionId) ?? 'active';
  }

  markActive(sessionId: string): void {
    this.states.set(sessionId, 'active');
  }

  assertMutable(sessionId: string): void {
    const state = this.state(sessionId);
    if (state !== 'active') throw new SessionLifecycleError(sessionId, state);
  }

  beginDelete(sessionId: string): SessionDeleteLease {
    this.assertMutable(sessionId);
    this.states.set(sessionId, 'deleting');
    let settled = false;
    return {
      commit: () => {
        if (settled) return;
        settled = true;
        this.states.set(sessionId, 'deleted');
      },
      rollback: () => {
        if (settled) return;
        settled = true;
        this.states.set(sessionId, 'active');
      }
    };
  }
}
