import type { LeaseMode, LeaseSnapshot } from '@desktop-agent/server-protocol';
import { ProtocolFailure } from './errors.js';

export class LeaseManager {
  private readonly bySession = new Map<string, Map<string, LeaseSnapshot>>();

  constructor(
    private readonly idGenerator: () => string = () => crypto.randomUUID(),
    private readonly now: () => Date = () => new Date()
  ) {}

  attach(sessionId: string, mode: LeaseMode, clientId: string, connectionId: string): LeaseSnapshot {
    const leases = this.bySession.get(sessionId) ?? new Map<string, LeaseSnapshot>();
    const existingForConnection = leases.get(connectionId);
    const control = [...leases.values()].find((lease) => lease.mode === 'control' && lease.connectionId !== connectionId);
    if (mode === 'control' && control) {
      throw new ProtocolFailure({ code: 'session_locked', message: 'The session already has a control lease.' });
    }
    const lease: LeaseSnapshot = existingForConnection?.mode === mode ? existingForConnection : {
      id: this.idGenerator(),
      sessionId,
      mode,
      clientId,
      connectionId,
      acquiredAt: this.now().toISOString()
    };
    leases.set(connectionId, lease);
    this.bySession.set(sessionId, leases);
    return structuredClone(lease);
  }

  detach(sessionId: string, connectionId: string): void {
    const leases = this.bySession.get(sessionId);
    leases?.delete(connectionId);
    if (leases?.size === 0) this.bySession.delete(sessionId);
  }

  releaseConnection(connectionId: string): void {
    for (const [sessionId, leases] of this.bySession) {
      leases.delete(connectionId);
      if (leases.size === 0) this.bySession.delete(sessionId);
    }
  }

  requireControl(sessionId: string, connectionId: string | undefined): void {
    if (!connectionId || this.bySession.get(sessionId)?.get(connectionId)?.mode !== 'control') {
      throw new ProtocolFailure({ code: 'session_locked', message: 'A control lease is required.' });
    }
  }

  get(sessionId: string, connectionId?: string): LeaseSnapshot | null {
    const leases = this.bySession.get(sessionId);
    if (!leases) return null;
    const selected = (connectionId ? leases.get(connectionId) : undefined)
      ?? [...leases.values()].find((lease) => lease.mode === 'control')
      ?? leases.values().next().value as LeaseSnapshot | undefined;
    return selected ? structuredClone(selected) : null;
  }
}
