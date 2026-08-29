import { describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest, PermissionGate, ToolCall } from '@desktop-agent/contracts';
import {
  ConversationGrantPermissionGate,
  ConversationPermissionGrants,
  defaultSimilarApprovalKey
} from './session-permission-grants';

const context = { sessionId: 'session-1', workingDirectory: '/workspace' };
const askingGate = (): PermissionGate => ({
  check: vi.fn(async (call: ToolCall) => ({
    decision: 'ask' as const,
    request: { requestId: crypto.randomUUID(), sessionId: context.sessionId, call, reason: 'approve' }
  }))
});

describe('conversation approval grants', () => {
  it('decorates approvals with the three requested choices without storing raw command text', async () => {
    const gate = new ConversationGrantPermissionGate(askingGate(), new ConversationPermissionGrants());
    const decision = await gate.check({
      id: 'call-1', name: 'terminal', input: { command: 'pnpm', args: ['test', '--token=visible-secret'], cwd: '.' }
    }, context);

    expect(decision).toMatchObject({
      decision: 'ask',
      request: { grant: { kind: 'approval', options: ['once', 'similar', 'conversation'] } }
    });
    if (decision.decision !== 'ask') throw new Error('Expected approval.');
    expect(decision.request.grant?.key).toMatch(/^approval:[a-f0-9]{64}$/u);
    expect(decision.request.grant?.key).not.toContain('visible-secret');
  });

  it('allows only a matching command family after choosing similar', async () => {
    const grants = new ConversationPermissionGrants();
    const base = askingGate();
    const gate = new ConversationGrantPermissionGate(base, grants);
    const first = await gate.check({ id: 'one', name: 'terminal', input: { command: 'pnpm', args: ['test', 'a'] } }, context);
    if (first.decision !== 'ask') throw new Error('Expected approval.');
    grants.grant(first.request, 'similar');

    await expect(gate.check({ id: 'two', name: 'terminal', input: { command: 'pnpm', args: ['test', 'b'] } }, context))
      .resolves.toEqual({ decision: 'allow' });
    await expect(gate.check({ id: 'three', name: 'terminal', input: { command: 'pnpm', args: ['lint'] } }, context))
      .resolves.toMatchObject({ decision: 'ask' });
    await expect(gate.check({ id: 'four', name: 'terminal', input: { command: 'pnpm', args: ['test', 'b'] } }, {
      ...context, sessionId: 'session-2'
    })).resolves.toMatchObject({ decision: 'ask' });
  });

  it('allows all ordinary approvals for the conversation and clears them with the session', async () => {
    const grants = new ConversationPermissionGrants();
    const gate = new ConversationGrantPermissionGate(askingGate(), grants);
    const first = await gate.check({ id: 'one', name: 'read_file', input: { path: '../outside.txt' } }, context);
    if (first.decision !== 'ask') throw new Error('Expected approval.');
    grants.grant(first.request, 'conversation');

    await expect(gate.check({ id: 'two', name: 'terminal', input: { command: 'git', args: ['status'] } }, context))
      .resolves.toEqual({ decision: 'allow' });
    grants.clear(context.sessionId);
    await expect(gate.check({ id: 'three', name: 'terminal', input: { command: 'git', args: ['status'] } }, context))
      .resolves.toMatchObject({ decision: 'ask' });
  });

  it('does not let conversation grants bypass persistent project hook trust', async () => {
    const grants = new ConversationPermissionGrants();
    const base = askingGate();
    const gate = new ConversationGrantPermissionGate(base, grants);
    const seed: ApprovalRequest = {
      requestId: 'seed', sessionId: context.sessionId,
      call: { id: 'seed-call', name: 'terminal', input: {} }, reason: 'seed',
      grant: { kind: 'approval', key: 'approval:seed', options: ['once', 'conversation'] }
    };
    grants.grant(seed, 'conversation');

    const decision = await gate.check({ id: 'hook', name: 'trust_project_hooks', input: {} }, context);
    expect(decision).toMatchObject({ decision: 'ask' });
    if (decision.decision !== 'ask') throw new Error('Expected approval.');
    expect(decision.request).not.toHaveProperty('grant');
  });

  it('groups external file reads by operation and parent directory', () => {
    const first = defaultSimilarApprovalKey({ id: 'one', name: 'read_file', input: { path: '../skills/a.md' } }, context);
    const second = defaultSimilarApprovalKey({ id: 'two', name: 'read_file', input: { path: '../skills/b.md' } }, context);
    const other = defaultSimilarApprovalKey({ id: 'three', name: 'read_file', input: { path: '../notes/a.md' } }, context);
    expect(first).toBe(second);
    expect(other).not.toBe(first);
  });

  it('does not offer a broad similar rule for shells or general interpreters', async () => {
    const gate = new ConversationGrantPermissionGate(askingGate(), new ConversationPermissionGrants());
    const decision = await gate.check({
      id: 'shell', name: 'terminal', input: { command: 'bash', args: ['-c', 'do-anything'] }
    }, context);
    expect(decision).toMatchObject({
      decision: 'ask', request: { grant: { options: ['once', 'conversation'] } }
    });
  });
});
