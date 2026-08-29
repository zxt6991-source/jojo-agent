import type { GrantScope, GovernanceRequest, PermissionGrant, PermissionGrantStore } from '../types.js';

type SessionGrants = { fingerprints: Set<string>; classes: Set<string> };

export class MemoryPermissionGrantStore implements PermissionGrantStore {
  private readonly sessions = new Map<string, SessionGrants>();
  private readonly remembered = new Map<string, GovernanceRequest>();

  private rememberedKey(sessionId: string, fingerprint: string): string {
    return `${sessionId}\u0000${fingerprint}`;
  }

  find(request: GovernanceRequest): PermissionGrant | undefined {
    const grants = this.sessions.get(request.context.sessionId);
    if (grants?.fingerprints.has(request.fingerprint)) return { key: request.fingerprint, scope: 'similar' };
    if (grants?.classes.has(request.grantClass)) return { key: request.grantClass, scope: 'conversation' };
    return undefined;
  }

  remember(request: GovernanceRequest): void {
    this.remembered.set(this.rememberedKey(request.context.sessionId, request.fingerprint), request);
  }

  grant(request: GovernanceRequest, scope: GrantScope): void {
    if (scope === 'once') return;
    const grants = this.sessions.get(request.context.sessionId) ?? {
      fingerprints: new Set<string>(), classes: new Set<string>()
    };
    if (scope === 'similar') grants.fingerprints.add(request.fingerprint);
    else grants.classes.add(request.grantClass);
    this.sessions.set(request.context.sessionId, grants);
  }

  grantApproval(sessionId: string, requestFingerprint: string, scope: GrantScope): boolean {
    const request = this.remembered.get(this.rememberedKey(sessionId, requestFingerprint));
    if (!request) return false;
    this.grant(request, scope);
    return true;
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    for (const [key, request] of this.remembered) {
      if (request.context.sessionId === sessionId) this.remembered.delete(key);
    }
  }
}
