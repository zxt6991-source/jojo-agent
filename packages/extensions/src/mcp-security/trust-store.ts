import type { McpTrustGrant, McpTrustStore } from '@desktop-agent/contracts';

export class MemoryMcpTrustStore implements McpTrustStore {
  private readonly grants = new Map<string, McpTrustGrant>();

  async get(serverId: string): Promise<McpTrustGrant | undefined> {
    const grant = this.grants.get(serverId);
    return grant ? structuredClone(grant) : undefined;
  }

  async trust(grant: McpTrustGrant): Promise<void> { this.grants.set(grant.serverId, structuredClone(grant)); }
  async revoke(serverId: string): Promise<void> { this.grants.delete(serverId); }
}
