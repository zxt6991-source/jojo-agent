import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteMcpTrustStore } from '../src/index.js';

describe('SqliteMcpTrustStore', () => {
  it('persists exact grants and revokes them', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'jojo-mcp-trust-'));
    const filename = path.join(root, 'trust.sqlite');
    const first = new SqliteMcpTrustStore(filename, () => 2_000);
    await first.trust({
      serverId: 'demo', fingerprint: 'a'.repeat(64), scope: 'user',
      capabilities: ['process:spawn'], allowInstructions: false,
      trustedAt: new Date(1_000).toISOString()
    });
    first.close();
    const reopened = new SqliteMcpTrustStore(filename);
    await expect(reopened.get('demo')).resolves.toMatchObject({ fingerprint: 'a'.repeat(64), capabilities: ['process:spawn'] });
    await reopened.revoke('demo');
    await expect(reopened.get('demo')).resolves.toBeUndefined();
    reopened.close();
  });
});
