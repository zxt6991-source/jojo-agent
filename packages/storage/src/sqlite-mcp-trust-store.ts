import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { McpTrustGrantSchema, type McpTrustGrant, type McpTrustStore } from '@desktop-agent/contracts';

type Row = Record<string, unknown>;

export class SqliteMcpTrustStore implements McpTrustStore {
  private readonly database: DatabaseSync;

  constructor(readonly filename: string, private readonly now: () => number = Date.now) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.database = new DatabaseSync(filename);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS mcp_trust (
        server_id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        scope TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        allow_instructions INTEGER NOT NULL,
        trusted_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  async get(serverId: string): Promise<McpTrustGrant | undefined> {
    const row = this.database.prepare('SELECT * FROM mcp_trust WHERE server_id = ?').get(serverId) as Row | undefined;
    if (!row) return undefined;
    return McpTrustGrantSchema.parse({
      serverId: row.server_id,
      fingerprint: row.fingerprint,
      scope: row.scope,
      capabilities: JSON.parse(String(row.capabilities_json)),
      allowInstructions: row.allow_instructions === 1,
      trustedAt: new Date(Number(row.trusted_at)).toISOString()
    });
  }

  async trust(grant: McpTrustGrant): Promise<void> {
    const parsed = McpTrustGrantSchema.parse(grant);
    const trustedAt = Date.parse(parsed.trustedAt);
    this.database.prepare(`
      INSERT INTO mcp_trust(server_id, fingerprint, scope, capabilities_json, allow_instructions, trusted_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(server_id) DO UPDATE SET
        fingerprint = excluded.fingerprint, scope = excluded.scope,
        capabilities_json = excluded.capabilities_json, allow_instructions = excluded.allow_instructions,
        trusted_at = excluded.trusted_at, updated_at = excluded.updated_at
    `).run(
      parsed.serverId, parsed.fingerprint, parsed.scope, JSON.stringify(parsed.capabilities),
      parsed.allowInstructions ? 1 : 0, trustedAt, this.now()
    );
  }

  async revoke(serverId: string): Promise<void> {
    this.database.prepare('DELETE FROM mcp_trust WHERE server_id = ?').run(serverId);
  }

  close(): void { this.database.close(); }
}
