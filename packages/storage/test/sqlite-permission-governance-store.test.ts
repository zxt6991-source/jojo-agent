import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SqlitePermissionGovernanceStore } from '../src/index.js';

const stores: SqlitePermissionGovernanceStore[] = [];
afterEach(() => { while (stores.length) stores.pop()?.close(); });

describe('SqlitePermissionGovernanceStore', () => {
  it('resolves workspace policy over global mode and increments revisions', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-permission-'));
    const store = new SqlitePermissionGovernanceStore(path.join(directory, 'permissions.sqlite'));
    stores.push(store);
    expect(store.saveProfile({ scope: 'global', mode: 'auto', document: { version: 1, rules: [] } })).toBe(1);
    expect(store.saveProfile({
      scope: 'workspace', scopeKey: '/workspace', mode: 'yolo',
      document: { version: 1, rules: [{ id: 'ask-terminal', effect: 'ask', match: { tools: ['terminal'] } }] }
    })).toBe(1);
    expect(store.saveProfile({
      scope: 'workspace', scopeKey: '/workspace', mode: 'ask',
      document: { version: 1, rules: [{ id: 'ask-terminal', effect: 'ask', match: { tools: ['terminal'] } }] }
    })).toBe(2);
    expect(store.resolve({
      sessionId: 's', laneId: 'main', runId: 'r', actor: { kind: 'main' }, trigger: { kind: 'user' },
      workingDirectory: '/workspace', executionScope: { kind: 'workspace', workingDirectory: '/workspace' }, interactive: true
    })).toMatchObject({ mode: 'ask', revision: 2, workspaceRules: [{ id: 'ask-terminal' }] });
    expect(store.getProfile('global')).toMatchObject({ scope: 'global', mode: 'auto', revision: 1 });
    expect(store.getProfile('workspace', '/workspace')).toMatchObject({
      scope: 'workspace', mode: 'ask', revision: 2, document: { rules: [{ id: 'ask-terminal' }] }
    });
    expect(store.getProfile('workspace', '/other')).toBeUndefined();
  });

  it('persists only redacted audit metadata', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-permission-'));
    const filename = path.join(directory, 'permissions.sqlite');
    const store = new SqlitePermissionGovernanceStore(filename);
    stores.push(store);
    store.record({
      createdAt: new Date(0).toISOString(),
      request: {
        id: 'request', call: { id: 'call', name: 'terminal', input: { token: 'visible-secret' } },
        context: { sessionId: 's', laneId: 'main', runId: 'r', actor: { kind: 'main' }, trigger: { kind: 'user' }, workingDirectory: '/workspace', executionScope: { kind: 'workspace', workingDirectory: '/workspace' }, interactive: true },
        baseline: { decision: 'allow' }, fingerprint: 'fingerprint', grantClass: 'class',
        facts: { source: 'native', operations: ['execute'], risk: 'medium', capabilities: ['process:spawn'], resourceScope: 'workspace', terminal: { executable: 'pnpm', subcommand: 'test', network: 'none', secretEnv: ['TOKEN'], sandbox: 'strong' } }
      },
      decision: { id: 'decision', effect: 'allow', locked: false, source: 'mode', reasonCode: 'auto_low_risk', reason: 'Allowed', requestFingerprint: 'fingerprint' }
    });
    store.record({
      createdAt: new Date(1).toISOString(),
      request: {
        id: 'request-2', call: { id: 'call-2', name: 'read_file', input: { path: 'README.md' } },
        context: { sessionId: 'other-session', laneId: 'main', runId: 'r2', actor: { kind: 'subagent', id: 'agent-1' }, trigger: { kind: 'subagent' }, workingDirectory: '/workspace', executionScope: { kind: 'workspace', workingDirectory: '/workspace' }, interactive: false },
        baseline: { decision: 'allow' }, fingerprint: 'fingerprint-2', grantClass: 'class-2',
        facts: { source: 'native', operations: ['read'], risk: 'low', capabilities: [], resourceScope: 'workspace' }
      },
      decision: { id: 'decision-2', effect: 'allow', locked: false, source: 'baseline', reasonCode: 'baseline_allow', reason: 'Allowed', requestFingerprint: 'fingerprint-2' }
    });
    expect(store.listAudit({ sessionId: 's' })).toEqual([expect.objectContaining({
      id: 'decision', sessionId: 's', toolName: 'terminal', effect: 'allow', metadata: expect.objectContaining({
        terminal: expect.objectContaining({ secretEnv: ['TOKEN'] })
      })
    })]);
    expect(store.listAudit({ limit: 1 })).toEqual([expect.objectContaining({ id: 'decision-2', actorKind: 'subagent' })]);
    store.close(); stores.pop();
    const database = new DatabaseSync(filename, { readOnly: true });
    const row = database.prepare("SELECT metadata_json FROM permission_decision_audit WHERE id = 'decision'").get() as { metadata_json: string };
    database.close();
    expect(row.metadata_json).toContain('TOKEN');
    expect(row.metadata_json).not.toContain('visible-secret');
    await expect(readFile(filename)).resolves.toBeDefined();
  });
});
