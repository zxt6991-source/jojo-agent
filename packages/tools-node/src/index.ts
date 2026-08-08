import { spawn } from 'node:child_process';
import { realpath, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ApprovalRequest, PermissionDecision, PermissionGate, Tool, ToolCall, ToolContext, ToolResult } from '@desktop-agent/contracts';

const ReadFileInput = z.object({ path: z.string().min(1) });
const ListFilesInput = z.object({ path: z.string().default('.'), depth: z.number().int().min(0).max(5).default(3) });
const TerminalInput = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).max(100).default([]),
  cwd: z.string().default('.'),
  timeoutMs: z.number().int().min(1_000).max(300_000).default(120_000)
});

const ignored = new Set(['.git', 'node_modules', 'dist', 'out', 'coverage', '.next', '.cache']);

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function canonicalRoot(root: string): Promise<string> {
  return realpath(path.resolve(root));
}

async function canonicalTarget(root: string, requested: string): Promise<string> {
  const absolute = path.resolve(root, requested);
  return realpath(absolute);
}

function toolResult(ok: boolean, content: string, truncated = false, code?: string): ToolResult {
  return { callId: '', ok, content, ...(truncated ? { truncated: true } : {}), ...(code ? { code } : {}) };
}

export class ReadFileTool implements Tool {
  readonly definition = {
    name: 'read_file',
    description: 'Read a UTF-8 text file. Paths are relative to the session working directory unless absolute.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }
  };
  constructor(private readonly maxBytes = 512_000) {}
  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const parsed = ReadFileInput.parse(input);
    const root = await canonicalRoot(context.workingDirectory);
    const target = await canonicalTarget(root, parsed.path);
    if (!inside(root, target) && !context.approved) return toolResult(false, 'Path is outside the working directory.', false, 'permission_denied');
    const info = await stat(target);
    if (!info.isFile()) return toolResult(false, 'The requested path is not a file.', false, 'not_a_file');
    const bytes = await readFile(target);
    const truncated = bytes.byteLength > this.maxBytes;
    const content = bytes.subarray(0, this.maxBytes).toString('utf8');
    return toolResult(true, truncated ? `${content}\n\n[truncated at ${this.maxBytes} bytes]` : content, truncated);
  }
}

export class ListFilesTool implements Tool {
  readonly definition = {
    name: 'list_files',
    description: 'List files under a directory in the session working directory.',
    inputSchema: {
      type: 'object', properties: { path: { type: 'string', default: '.' }, depth: { type: 'integer', minimum: 0, maximum: 5, default: 3 } }, additionalProperties: false
    }
  };
  constructor(private readonly maxEntries = 500) {}
  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const parsed = ListFilesInput.parse(input);
    const root = await canonicalRoot(context.workingDirectory);
    const target = await canonicalTarget(root, parsed.path);
    if (!inside(root, target)) return toolResult(false, 'Directory is outside the working directory.', false, 'permission_denied');
    const lines: string[] = [];
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (lines.length >= this.maxEntries) return;
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (lines.length >= this.maxEntries || ignored.has(entry.name)) continue;
        const candidate = path.join(directory, entry.name);
        let resolved: string;
        try { resolved = await realpath(candidate); } catch { continue; }
        if (!inside(root, resolved)) continue;
        const relative = path.relative(root, candidate) || '.';
        lines.push(`${entry.isDirectory() ? 'dir ' : 'file'} ${relative}`);
        if (entry.isDirectory() && depth < parsed.depth) await walk(candidate, depth + 1);
      }
    };
    await walk(target, 0);
    const truncated = lines.length >= this.maxEntries;
    return toolResult(true, `${lines.join('\n')}${truncated ? '\n[entry limit reached]' : ''}`, truncated);
  }
}

export class TerminalTool implements Tool {
  readonly definition = {
    name: 'terminal',
    description: 'Run one executable with an argument array. This tool always requires user approval.',
    inputSchema: {
      type: 'object', properties: {
        command: { type: 'string' }, args: { type: 'array', items: { type: 'string' }, default: [] },
        cwd: { type: 'string', default: '.' }, timeoutMs: { type: 'integer', minimum: 1000, maximum: 300000, default: 120000 }
      }, required: ['command'], additionalProperties: false
    }
  };
  constructor(private readonly maxBytes = 1_000_000) {}
  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const parsed = TerminalInput.parse(input);
    const root = await canonicalRoot(context.workingDirectory);
    const cwd = await canonicalTarget(root, parsed.cwd);
    if (!inside(root, cwd)) return toolResult(false, 'Terminal cwd is outside the working directory.', false, 'permission_denied');
    return new Promise<ToolResult>((resolve) => {
      const child = spawn(parsed.command, parsed.args, {
        cwd, shell: false, detached: process.platform !== 'win32', env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let output = '';
      let bytes = 0;
      let truncated = false;
      let settled = false;
      const append = (label: string, chunk: Buffer) => {
        if (bytes >= this.maxBytes) { truncated = true; return; }
        const remaining = this.maxBytes - bytes;
        const slice = chunk.subarray(0, remaining);
        bytes += slice.byteLength;
        if (slice.byteLength < chunk.byteLength) truncated = true;
        const text = slice.toString('utf8');
        output += label ? `[${label}] ${text}` : text;
        context.onProgress(text);
      };
      child.stdout?.on('data', (chunk: Buffer) => append('', chunk));
      child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));
      const stop = () => {
        if (!child.pid) return;
        try {
          if (process.platform === 'win32') child.kill('SIGTERM');
          else process.kill(-child.pid, 'SIGTERM');
        } catch { child.kill('SIGTERM'); }
      };
      const timeout = setTimeout(stop, parsed.timeoutMs);
      const onAbort = () => stop();
      context.signal.addEventListener('abort', onAbort, { once: true });
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        context.signal.removeEventListener('abort', onAbort);
        resolve(toolResult(false, error.message, false, 'spawn_failed'));
      });
      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        context.signal.removeEventListener('abort', onAbort);
        if (context.signal.aborted) return resolve(toolResult(false, `${output}\n[cancelled]`, truncated, 'cancelled'));
        const ok = code === 0;
        resolve(toolResult(ok, `${output}${truncated ? '\n[output truncated]' : ''}\n[exit ${code ?? signal ?? 'unknown'}]`, truncated, ok ? undefined : 'nonzero_exit'));
      });
    });
  }
}

export class DefaultPermissionGate implements PermissionGate {
  async check(call: ToolCall, context: { sessionId: string; workingDirectory: string }): Promise<PermissionDecision> {
    if (call.name === 'terminal') return { decision: 'ask', request: this.request(call, context.sessionId, 'Run a local command') };
    if (call.name === 'list_files') {
      const parsed = ListFilesInput.safeParse(call.input);
      if (!parsed.success) return { decision: 'deny', reason: parsed.error.message };
      try {
        const root = await canonicalRoot(context.workingDirectory);
        const target = await canonicalTarget(root, parsed.data.path);
        return inside(root, target) ? { decision: 'allow' } : { decision: 'deny', reason: 'Listing outside the working directory is not allowed.' };
      } catch (error) { return { decision: 'deny', reason: error instanceof Error ? error.message : String(error) }; }
    }
    if (call.name === 'read_file') {
      const parsed = ReadFileInput.safeParse(call.input);
      if (!parsed.success) return { decision: 'deny', reason: parsed.error.message };
      try {
        const root = await canonicalRoot(context.workingDirectory);
        const target = await canonicalTarget(root, parsed.data.path);
        return inside(root, target) ? { decision: 'allow' } : { decision: 'ask', request: this.request(call, context.sessionId, 'Read a file outside the working directory') };
      } catch (error) { return { decision: 'deny', reason: error instanceof Error ? error.message : String(error) }; }
    }
    return { decision: 'deny', reason: `Unknown tool: ${call.name}` };
  }
  private request(call: ToolCall, sessionId: string, reason: string): ApprovalRequest {
    return { requestId: crypto.randomUUID(), sessionId, call, reason };
  }
}

export const createDefaultTools = (): Tool[] => [new ReadFileTool(), new ListFilesTool(), new TerminalTool()];
