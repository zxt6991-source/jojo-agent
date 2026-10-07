import { createHash, randomUUID } from 'node:crypto';
import { WorkspaceRevisionService } from './workspace-revision.js';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { VerificationProfileSchema, type Tool, type ToolContext, type ToolResult } from '@desktop-agent/contracts';
import { resolveWorkspacePath } from './workspace-paths.js';
/** Repository configuration is data: it suggests inputs, never executes or authorizes them. */
export class VerificationProfileTool implements Tool {
  readonly risk = 'read' as const;
  readonly replay = 'safe' as const;
  readonly definition = {
    name: 'verification_profile',
    description: 'Read optional .jojo/verification.json project lint/typecheck/test suggestions and a durable batch deadline. All checks share the Profile wall-clock budget, including approval waits. Call this again to explicitly start a new batch. Use verification_run with batchId and optional checkIds, or run selected commands separately through terminal with the returned verification metadata; every command retains ordinary permission and sandbox checks. Report omitted checks as skipped. Read before claiming code changes verified.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  };
  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) return { callId: '', ok: false, code: 'invalid_input', content: 'Expected an empty object.' };
    const resolved = await resolveWorkspacePath(context.workingDirectory, '.jojo/verification.json');
    if (!resolved.inside) return { callId: '', ok: false, code: 'permission_denied', content: 'Profile is outside the workspace.' };
    try {
      const file = await open(resolved.target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let content: string;
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > 64000) throw new Error('Profile must be a regular file of at most 64,000 bytes.');
        const bytes = Buffer.alloc(64001);
        const read = await file.read(bytes, 0, bytes.length, 0);
        if (read.bytesRead > 64000) throw new Error('Profile exceeds the size limit.');
        content = bytes.subarray(0, read.bytesRead).toString('utf8');
      } finally { await file.close(); }
      const profile = VerificationProfileSchema.parse(JSON.parse(content));
      const timestamp = new Date().toISOString();
      const batchId = randomUUID();
      const revision = await new WorkspaceRevisionService().capture({ workingDirectory: context.workingDirectory, ...(profile.version === 2 ? { inputs: profile.inputs } : {}), signal: context.signal });
      const batch = { id: batchId, createdAt: timestamp, deadlineAt: new Date(Date.parse(timestamp) + profile.budgetMs).toISOString(), profileHash: createHash('sha256').update(JSON.stringify(profile)).digest('hex'), profile, revision };
      const commands = profile.commands.map(item => ({ ...item, terminalInput: {
        command: item.command, args: item.args, cwd: item.cwd, timeoutMs: item.timeoutMs,
        verification: { kind: item.kind, scope: item.scope, profileId: item.id, batchId }
      } }));
      return { callId: '', ok: true, content: JSON.stringify({ batchId, deadlineAt: batch.deadlineAt, budgetMs: profile.budgetMs, commands }), structuredResult: { profile }, verificationBatch: batch, verificationChecks: profile.commands.map(item => ({
        kind: item.kind, scope: item.scope, profileId: item.id, batchId, command: item.command, args: item.args, cwd: item.cwd,
        status: 'skipped', startedAt: timestamp, finishedAt: timestamp, exitCode: null, changeId: 'not-run', reason: 'not_run'
      })) };
    } catch (error) {
      context.signal.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { callId: '', ok: true, code: 'profile_absent', content: 'No verification profile. Discover project commands from package metadata and run them via terminal; do not claim unexecuted checks passed.' };
      return { callId: '', ok: false, code: 'invalid_verification_profile', content: error instanceof Error ? error.message : String(error) };
    }
  }
}
