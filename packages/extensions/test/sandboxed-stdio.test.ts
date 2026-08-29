import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { serializeMessage, type JSONRPCMessage } from '@modelcontextprotocol/client';
import type { ProcessSandbox, SandboxProcess, SandboxSpec } from '@desktop-agent/process-sandbox';
import { mcpStdioSandboxSpec, SandboxedStdioTransport } from '../src/index.js';

describe('SandboxedStdioTransport', () => {
  it('uses no workspace mount or network by default', () => {
    const spec = mcpStdioSandboxSpec({
      id: 'isolated', name: 'Isolated', enabled: true, transport: 'stdio', command: 'server', args: []
    });
    expect(spec).toMatchObject({
      stdin: 'pipe', isolatedCwd: true, mounts: [], network: { mode: 'none' }, fakeHome: true, tmpfs: true
    });
    expect(spec.env).not.toHaveProperty('SSH_AUTH_SOCK');
  });

  it('maps explicit workspace access to a read-only or writable mount', () => {
    const read = mcpStdioSandboxSpec({
      id: 'read', name: 'Read', enabled: true, transport: 'stdio', command: 'server', args: [],
      cwd: process.cwd(), security: { workspaceAccess: 'read' }
    });
    const write = mcpStdioSandboxSpec({
      id: 'write', name: 'Write', enabled: true, transport: 'stdio', command: 'server', args: [],
      cwd: process.cwd(), security: { workspaceAccess: 'write', network: 'outbound' }
    });
    expect(read.mounts).toEqual([{ path: process.cwd(), mode: 'ro' }]);
    expect(write.mounts).toEqual([{ path: process.cwd(), mode: 'rw' }]);
    expect(write.network).toEqual({ mode: 'host' });
  });

  it('exchanges JSON-RPC over a process created by ProcessSandbox', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const terminate = vi.fn(async () => undefined);
    const handle: SandboxProcess = {
      strength: 'strong', stdin, stdout, stderr, wait: () => new Promise(() => undefined),
      terminate, kill: async () => undefined
    };
    const sandbox: ProcessSandbox = {
      probe: async () => ({ available: true, strength: 'strong' }),
      spawn: vi.fn(async (_spec: SandboxSpec) => handle)
    };
    const transport = new SandboxedStdioTransport(sandbox, mcpStdioSandboxSpec({
      id: 'rpc', name: 'RPC', enabled: true, transport: 'stdio', command: 'rpc', args: []
    }));
    const received = vi.fn();
    transport.onmessage = received;
    let sent = '';
    stdin.on('data', (chunk) => { sent += chunk.toString(); });
    await transport.start();
    const notification: JSONRPCMessage = { jsonrpc: '2.0', method: 'notifications/initialized' };
    await transport.send(notification);
    expect(sent).toBe(serializeMessage(notification));
    stdout.write(serializeMessage(notification));
    expect(received).toHaveBeenCalledWith(notification);
    await transport.close();
    expect(terminate).toHaveBeenCalled();
  });
});
