import path from 'node:path';
import os from 'node:os';
import {
  ReadBuffer, serializeMessage,
  type JSONRPCMessage, type Transport, type TransportSendOptions
} from '@modelcontextprotocol/client';
import {
  createSandboxEnvironment,
  type ProcessSandbox,
  type SandboxProcess,
  type SandboxSpec
} from '@desktop-agent/process-sandbox';
import type { McpServerConfig } from '@desktop-agent/contracts';

export class SandboxedStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private process: SandboxProcess | undefined;
  private readonly buffer = new ReadBuffer({ maxBufferSize: 10 * 1024 * 1024 });

  constructor(private readonly sandbox: ProcessSandbox, private readonly spec: SandboxSpec) {}

  async start(): Promise<void> {
    if (this.process) throw new Error('Sandboxed stdio transport is already started.');
    const processHandle = await this.sandbox.spawn(this.spec);
    if (!processHandle.stdin) {
      await processHandle.kill();
      throw new Error('mcp_stdio_sandbox_unavailable: sandbox did not provide stdin.');
    }
    this.process = processHandle;
    processHandle.stdout.on('data', (chunk: Buffer) => {
      try {
        this.buffer.append(chunk);
        while (true) {
          const message = this.buffer.readMessage();
          if (message === null) break;
          this.onmessage?.(message);
        }
      } catch (error) { this.onerror?.(error instanceof Error ? error : new Error(String(error))); }
    });
    processHandle.stdout.on('error', (error) => this.onerror?.(error));
    processHandle.stderr.on('data', () => undefined);
    void processHandle.wait().then(() => {
      if (this.process === processHandle) {
        this.process = undefined;
        this.onclose?.();
      }
    }).catch((error) => this.onerror?.(error instanceof Error ? error : new Error(String(error))));
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    const stdin = this.process?.stdin;
    if (!stdin) throw new Error('MCP stdio transport is not connected.');
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { stdin.removeListener('drain', onDrain); reject(error); };
      const onDrain = () => { stdin.removeListener('error', onError); resolve(); };
      stdin.once('error', onError);
      if (stdin.write(serializeMessage(message))) {
        stdin.removeListener('error', onError);
        resolve();
      } else stdin.once('drain', onDrain);
    });
  }

  async close(): Promise<void> {
    const active = this.process;
    this.process = undefined;
    this.buffer.clear();
    if (active) {
      active.stdin?.end();
      await active.terminate();
    }
    this.onclose?.();
  }
}

export function mcpStdioSandboxSpec(config: Extract<McpServerConfig, { transport: 'stdio' }>, resolvedEnvironment: Record<string, string> = {}): SandboxSpec {
  const workspaceAccess = config.security?.workspaceAccess ?? 'none';
  const cwd = workspaceAccess === 'none' ? os.tmpdir() : path.resolve(config.cwd ?? process.cwd());
  return {
    id: `mcp-${config.id}-${crypto.randomUUID()}`, cwd, isolatedCwd: workspaceAccess === 'none',
    command: config.command, args: [...config.args], stdin: 'pipe',
    env: { ...createSandboxEnvironment({ workingDirectory: cwd }), ...resolvedEnvironment },
    mounts: workspaceAccess === 'none' ? [] : [{ path: cwd, mode: workspaceAccess === 'write' ? 'rw' : 'ro' }],
    network: { mode: (config.security?.network ?? 'none') === 'none' ? 'none' : 'host' },
    fakeHome: true, tmpfs: true,
    resources: { timeoutMs: 24 * 60 * 60 * 1_000, maxOutputBytes: 10 * 1024 * 1024, maxProcesses: 32 }
  };
}
