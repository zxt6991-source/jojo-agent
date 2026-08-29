import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ApprovalRequest, PermissionDecision, PermissionGate, ToolCall } from '@desktop-agent/contracts';

export type ApprovalGrantScope = 'once' | 'similar' | 'conversation';
export type SimilarApprovalKey = (
  call: ToolCall,
  context: { sessionId: string; workingDirectory: string }
) => string | undefined;

type SessionGrants = { conversation: boolean; similar: Set<string> };
const SIMILAR_TERMINAL_COMMANDS = new Set([
  'git', 'pnpm', 'npm', 'npx', 'yarn', 'bun', 'cargo', 'go', 'make', 'cmake',
  'tsc', 'vitest', 'jest', 'eslint', 'prettier'
]);

export class ConversationPermissionGrants {
  private readonly sessions = new Map<string, SessionGrants>();

  allows(sessionId: string, key: string | undefined): boolean {
    const grants = this.sessions.get(sessionId);
    return grants?.conversation === true || Boolean(key && grants?.similar.has(key));
  }

  grant(request: ApprovalRequest, scope: ApprovalGrantScope): void {
    if (scope === 'once') return;
    const grants = this.sessions.get(request.sessionId) ?? { conversation: false, similar: new Set<string>() };
    if (scope === 'conversation') grants.conversation = true;
    else if (request.grant?.options.includes('similar')) grants.similar.add(request.grant.key);
    this.sessions.set(request.sessionId, grants);
  }

  clear(sessionId: string): void { this.sessions.delete(sessionId); }
}

export class ConversationGrantPermissionGate implements PermissionGate {
  constructor(
    private readonly base: PermissionGate,
    private readonly grants: ConversationPermissionGrants,
    private readonly similarKey: SimilarApprovalKey = defaultSimilarApprovalKey
  ) {}

  async check(
    call: ToolCall,
    context: { sessionId: string; workingDirectory: string }
  ): Promise<PermissionDecision> {
    const decision = await this.base.check(call, context);
    if (decision.decision !== 'ask' || call.name === 'trust_project_hooks') return decision;
    const key = this.similarKey(call, context);
    if (this.grants.allows(context.sessionId, key)) return { decision: 'allow' };
    return {
      decision: 'ask',
      request: {
        ...decision.request,
        grant: {
          kind: 'approval',
          key: key ?? hashGrantKey(['tool', call.name]),
          options: key ? ['once', 'similar', 'conversation'] : ['once', 'conversation']
        }
      }
    };
  }
}

export function defaultSimilarApprovalKey(
  call: ToolCall,
  context: { workingDirectory: string }
): string | undefined {
  const input = call.input && typeof call.input === 'object' && !Array.isArray(call.input)
    ? call.input as Record<string, unknown>
    : {};
  if (call.name === 'terminal') {
    const command = typeof input.command === 'string' ? input.command : '';
    const executable = path.basename(command).toLowerCase();
    if (!SIMILAR_TERMINAL_COMMANDS.has(executable)) return undefined;
    const firstArgument = Array.isArray(input.args) && typeof input.args[0] === 'string' ? input.args[0] : '';
    const cwd = typeof input.cwd === 'string' ? input.cwd : '.';
    const network = input.network === 'host' ? 'host' : 'none';
    const secretEnv = Array.isArray(input.secretEnv)
      ? input.secretEnv.filter((name): name is string => typeof name === 'string').sort()
      : [];
    return command ? hashGrantKey(['terminal', executable, firstArgument, cwd, network, ...secretEnv]) : undefined;
  }
  if (['read_file', 'write_file', 'edit_file', 'delete_file'].includes(call.name) && typeof input.path === 'string') {
    return hashGrantKey([call.name, path.dirname(path.resolve(context.workingDirectory, input.path))]);
  }
  if (call.name.startsWith('mcp_') && typeof input.serverId === 'string') {
    return hashGrantKey([call.name, input.serverId]);
  }
  if (call.name.startsWith('browser_') && typeof input.url === 'string') {
    try { return hashGrantKey([call.name, new URL(input.url).origin]); } catch { /* Fall through to the tool name. */ }
  }
  return hashGrantKey(['tool', call.name]);
}

function hashGrantKey(parts: string[]): string {
  return `approval:${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
}
