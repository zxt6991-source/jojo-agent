import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { verificationFacts, verificationResult, AgentEventSchema, WorkspaceRevisionSchema, type Message, type ToolContext } from '@desktop-agent/contracts';
import { ResultReadTool, VerificationProfileTool, VerificationRunTool, DefaultPermissionGate } from '../src/index.js';
const context: ToolContext = { sessionId: 's', workingDirectory: process.cwd(), approved: true, signal: new AbortController().signal, onProgress: () => undefined };

describe('verification and durable result windows', () => {
  it('reads middle evidence in bounded windows without leaking unknown results', async () => {
    const content = 'a'.repeat(20000) + 'ERROR middle' + 'z'.repeat(20000);
    const tool = new ResultReadTool();
    const scoped = { ...context, readToolResult: async (id: string) => id === 'allowed' ? { callId: id, ok: false, content } : undefined };
    expect(await tool.execute({ callId: 'allowed', offset: 20000, limit: 12 }, scoped)).toMatchObject({ content: 'ERROR middle', structuredResult: { nextOffset: 20012 } });
    expect(await tool.execute({ callId: 'other-session' }, scoped)).toMatchObject({ ok: false, code: 'result_not_found' });
    await expect(tool.execute({ callId: 'allowed', limit: 12001 }, scoped)).rejects.toThrow();
  });
  it('does not execute commands found in a profile', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'verification-profile-'));
    await mkdir(path.join(root, '.jojo'));
    await writeFile(path.join(root, '.jojo/verification.json'), JSON.stringify({ version: 1, commands: [{ id: 'types', kind: 'typecheck', command: 'pnpm', args: ['typecheck'], scope: 'repository' }] }));
    const result = await new VerificationProfileTool().execute({}, { ...context, workingDirectory: root });
    const input = JSON.parse(result.content).commands[0].terminalInput;
    expect(input).toMatchObject({ command: 'pnpm', verification: { kind: 'typecheck', profileId: 'types' } });
    const denied = await new DefaultPermissionGate().check({ id: 'escape', name: 'terminal', input: { ...input, cwd: '../outside' } }, { sessionId: 's', workingDirectory: root });
    expect(denied.decision).toBe('deny');
  });
  it('marks denied checks skipped and detects later file changes', () => {
    const call = { id: 'test', name: 'terminal', input: { command: 'pnpm', args: ['test'], verification: { kind: 'test', scope: 'all' } } };
    const skipped = verificationResult(call, { callId: call.id, ok: false, code: 'user_denied', content: 'denied' });
    expect(skipped.verification?.status).toBe('skipped');
    const passed = { ...skipped, ok: true, verification: { ...skipped.verification!, status: 'passed' as const, exitCode: 0 } };
    const messages: Message[] = [
      { id: 'a', role: 'assistant', createdAt: new Date().toISOString(), content: [{ type: 'tool_call', call }] },
      { id: 'r', role: 'tool', createdAt: new Date().toISOString(), content: [{ type: 'tool_result', result: passed }] }
    ];
    expect(verificationFacts(messages)[0]?.stale).toBe(false);
    messages.push({ id: 'edit', role: 'assistant', createdAt: new Date().toISOString(), content: [{ type: 'tool_call', call: { id: 'edit-call', name: 'edit_file', input: {} } }] }, { id: 'edited', role: 'tool', createdAt: new Date().toISOString(), content: [{ type: 'tool_result', result: { callId: 'edit-call', ok: true, content: 'written' } }] });
    expect(verificationFacts(messages)[0]?.stale).toBe(true);
  });
});

it('keeps a maximum-check batch IPC-safe without duplicating large revision scopes', async () => {
  const timestamp = new Date().toISOString();
  const patterns = Array.from({ length: 50 }, (_, i) => `src/${i}/${'a'.repeat(490)}*`);
  const revision = WorkspaceRevisionSchema.parse({ id: 'a'.repeat(64), workspaceId: 'b'.repeat(64), scopeHash: 'c'.repeat(64), inputs: { mode: 'paths', include: patterns, exclude: patterns }, capturedAt: timestamp, captureStatus: 'complete', fileCount: 1, byteCount: 1 });
  const result = await new VerificationRunTool().execute({ batchId: 'batch' }, { ...context, runVerificationChecks: async () => Array.from({ length: 20 }, (_, i) => ({ callId: `check-${i}`, ok: true, content: '', verification: { kind: 'test' as const, scope: 'src', command: 'node', args: [], cwd: '.', startedAt: timestamp, finishedAt: timestamp, exitCode: 0, status: 'passed' as const, changeId: `check-${i}`, outputRef: `check-${i}`, revisionBefore: revision, revisionAfter: revision, validity: 'current' as const } })) });
  expect(result.content.length).toBeLessThan(20000);
  expect(result.content).not.toContain(patterns[0]);
  expect(AgentEventSchema.safeParse({ type: 'tool.finished', id: 'batch-run', result: { ...result, callId: 'batch-run' } }).success).toBe(true);
});
