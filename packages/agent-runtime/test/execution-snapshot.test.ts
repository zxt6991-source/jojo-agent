import { mkdtemp, mkdir, symlink, unlink, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestExecutionSnapshot } from '../src/testing/index.js';
import { assertPersistableInstructions, describeProviderConfiguration, executionFingerprint, executionInstructions, instructionContentHash, normalizeExecutionBudget, parseExecutionSnapshot, validateOperationExecution, validateOperationRecordSize, validateExecutionWorkspace } from '../src/operation/execution-snapshot.js';

const contribution = (content = 'extension instruction') => ({ kind: 'instruction' as const, id: 'server-a', source: 'mcp', priority: 50,
  content, contentHash: instructionContentHash(content), sourceFingerprint: executionFingerprint('extension-v1') });

describe('execution snapshot protocol', () => {
  it('round trips all identities, duplicate requested instructions, and stable source order', () => {
    const first = contribution();
    const second = { ...contribution('other'), id: 'server-b' };
    const instructions = executionInstructions(['one', 'one', 'two'], [second, first, first]);
    expect(instructions.requested).toEqual(['one', 'one', 'two']);
    expect(instructions.contributed.map(block => block.id)).toEqual(['server-a', 'server-b']);
    expect(instructions).toEqual(executionInstructions(['one', 'one', 'two'], [first, second]));
    const snapshot = createTestExecutionSnapshot({ actor: { kind: 'team_member', id: 'member', profile: 'general' },
      trigger: { kind: 'scheduler', id: 'schedule' }, workflow: { id: 'workflow', runId: 'run', stepId: 'step' }, team: { id: 'team', memberId: 'member' }, instructions });
    expect(parseExecutionSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
  });
  it.each([0, 2, null])('rejects version %s without echoing content', version => {
    const snapshot = { ...createTestExecutionSnapshot(), schemaVersion: version };
    expect(() => parseExecutionSnapshot(snapshot)).toThrow('runtime_execution_snapshot_version_unsupported');
  });
  it('rejects corrupt hashes, extra fields and conflicting contributions', () => {
    const snapshot = createTestExecutionSnapshot({ instructions: executionInstructions(['private instruction'], [contribution()]) });
    snapshot.instructions.requested[0] = 'tampered-secret-canary';
    expect(() => parseExecutionSnapshot(snapshot)).toThrow('runtime_execution_snapshot_invalid: instructions.fingerprint');
    expect(() => parseExecutionSnapshot({ ...createTestExecutionSnapshot(), credentials: 'canary' })).toThrow('runtime_execution_snapshot_invalid');
    expect(() => executionInstructions([], [contribution(), contribution('conflict')])).toThrow('runtime_execution_snapshot_invalid');
  });
  it('enforces UTF-8 and aggregate limits without truncation', () => {
    const valid = createTestExecutionSnapshot({ instructions: executionInstructions(['中'.repeat(10922)], []) });
    expect(parseExecutionSnapshot(valid)).toEqual(valid);
    expect(() => createTestExecutionSnapshot({ instructions: executionInstructions(['中'.repeat(10923)], []) })).toThrow('runtime_execution_snapshot_too_large');
    expect(() => createTestExecutionSnapshot({ instructions: executionInstructions(Array(7).fill('a'.repeat(32768)), []) })).toThrow('runtime_execution_snapshot_too_large');
    expect(() => validateOperationRecordSize(JSON.stringify({ type: 'operation.started', meta: { text: 'a'.repeat(768 * 1024) } }))).toThrow('runtime_execution_snapshot_too_large');
  });
  it('rejects deeply nested custom scope and credential fields', () => {
    let data: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) data = { nested: data };
    expect(() => parseExecutionSnapshot({ ...createTestExecutionSnapshot(), executionScope: { kind: 'custom', type: 'x', data } })).toThrow('runtime_execution_snapshot_too_large');
    expect(() => parseExecutionSnapshot({ ...createTestExecutionSnapshot(), executionScope: { kind: 'custom', type: 'x', data: { apiKey: 'canary' } } })).toThrow('runtime_execution_snapshot_invalid');
  });
  it.each([NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid budget %s', value => {
    expect(() => normalizeExecutionBudget({ maxOutputTokens: value })).toThrow('runtime_execution_snapshot_invalid');
    expect(() => normalizeExecutionBudget({ maxIterations: value })).toThrow('runtime_execution_snapshot_invalid');
  });
  it('rejects a workspace symlink replaced with a different project', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'snapshot-scope-'));
    const first = path.join(directory, 'first');
    const second = path.join(directory, 'second');
    const link = path.join(directory, 'workspace');
    await mkdir(first); await mkdir(second); await symlink(first, link);
    const snapshot = createTestExecutionSnapshot({ executionScope: { kind: 'workspace', workingDirectory: link },
      runContext: { executionPolicyFingerprint: executionFingerprint('policy'), projectIdentity: {
        id: `prj_${'0'.repeat(64)}`, displayName: 'project', canonicalPath: await realpath(first)
      } } });
    await expect(validateExecutionWorkspace(snapshot)).resolves.toBeUndefined();
    await unlink(link); await symlink(second, link);
    await expect(validateExecutionWorkspace(snapshot)).rejects.toThrow('runtime_resume_scope_changed');
  });
  it('rejects mismatching meta and resource budget corruption', () => {
    const execution = createTestExecutionSnapshot();
    const meta = { id: 'o', sessionId: 's', lane: 'main', kind: 'run' as const, createdAt: 1, providerId: 'provider-1', model: 'model-1', maxIterations: 12, execution };
    expect(() => validateOperationExecution({ ...meta, maxIterations: 13 })).toThrow('runtime_execution_snapshot_invalid');
    expect(() => validateOperationExecution({ ...meta, config: { maxWallTimeMs: NaN } })).toThrow('runtime_execution_snapshot_invalid');
  });
  it('ignores credentials in provider configuration but detects endpoint/adapter changes', () => {
    const config = { id: 'provider', protocol: 'openai', baseUrl: 'https://example.test/v1', apiKey: 'CANARY-key', headers: { authorization: 'CANARY-header' } };
    const binding = describeProviderConfiguration(config, 'model');
    const rotated = { ...config, apiKey: 'rotated-key' };
    expect(binding).toEqual(describeProviderConfiguration(rotated, 'model'));
    expect(binding).not.toEqual(describeProviderConfiguration({ ...config, baseUrl: 'https://other.test/v1' }, 'model'));
    expect(binding).not.toEqual(describeProviderConfiguration({ ...config, protocol: 'anthropic' }, 'model'));
    expect(JSON.stringify(binding)).not.toContain('CANARY');
    for (const baseUrl of ['https://user:password@example.test', 'https://example.test?key=CANARY']) {
      expect(() => describeProviderConfiguration({ ...config, baseUrl }, 'model')).toThrow('runtime_execution_snapshot_invalid');
    }
    expect(() => assertPersistableInstructions(['a CANARY-key prompt'], ['CANARY-key'])).toThrow('runtime_execution_snapshot_invalid: instructions');
  });
});
