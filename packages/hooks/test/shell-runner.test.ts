import { describe, expect, it } from 'vitest';
import { parsePreToolOutput, sanitizedHookEnvironment, ShellHookRunner } from '../src/index.js';
import type { PreToolUsePayload } from '@desktop-agent/contracts';

const payload: PreToolUsePayload = {
  schemaVersion: 1,
  eventId: 'event-1',
  event: 'PreToolUse',
  timestamp: new Date().toISOString(),
  sessionId: 'session-1',
  operationId: 'operation-1',
  lane: 'main',
  agent: { kind: 'main' },
  workingDirectory: process.cwd(),
  provider: { id: 'provider-1', model: 'model-1' },
  transport: 'cli',
  toolCallId: 'call-1',
  toolName: 'terminal',
  toolInput: {}
};

describe('ShellHookRunner', () => {
  it('sends the JSON envelope on stdin and supports exit code 2 blocking', async () => {
    const script = "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const p=JSON.parse(s);process.stdout.write(JSON.stringify({decision:'block',reason:p.toolName}));process.exit(2)})";
    const result = await new ShellHookRunner().run({
      command: `"${process.execPath}" -e "${script}"`, payload, cwd: process.cwd(), timeoutMs: 5_000
    });
    expect(parsePreToolOutput(result)).toEqual({ decision: 'block', reason: 'terminal' });
  });

  it('times out and terminates a long-running process', async () => {
    await expect(new ShellHookRunner().run({
      command: `"${process.execPath}" -e "setInterval(()=>{},1000)"`,
      payload,
      cwd: process.cwd(),
      timeoutMs: 30
    })).rejects.toMatchObject({ code: 'hook_timeout' });
  });

  it('removes provider secrets from inherited environment', () => {
    expect(sanitizedHookEnvironment({
      PATH: '/bin', OPENAI_API_KEY: 'secret', INTERNAL_TOKEN: 'secret', SAFE_VALUE: 'ok', NODE_OPTIONS: '--inspect'
    })).toEqual({ PATH: '/bin', SAFE_VALUE: 'ok' });
  });
});
