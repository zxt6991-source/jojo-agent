import type {
  ApprovalRequest,
  PermissionDecision,
  PermissionGate,
  SecurityApprovalPreview,
  ToolCall
} from '@desktop-agent/contracts';

export class McpSessionPermissionGrants {
  private readonly grants = new Map<string, Set<string>>();

  has(sessionId: string, key: string): boolean { return this.grants.get(sessionId)?.has(key) ?? false; }

  grant(sessionId: string, key: string): void {
    const values = this.grants.get(sessionId) ?? new Set<string>();
    values.add(key);
    this.grants.set(sessionId, values);
  }

  clear(sessionId: string): void { this.grants.delete(sessionId); }
}

function mcpToolGrantKey(call: ToolCall): string | undefined {
  if (call.name.startsWith('mcp__')) return call.name;
  if (call.name !== 'mcp_tool_call' || !call.input || typeof call.input !== 'object' || Array.isArray(call.input)) return undefined;
  const name = (call.input as Record<string, unknown>).name;
  return typeof name === 'string' && name.startsWith('mcp__') ? name : undefined;
}

export class ExtensionPermissionGate implements PermissionGate {
  constructor(
    private readonly base: PermissionGate,
    private readonly sessionGrants: McpSessionPermissionGrants = new McpSessionPermissionGrants(),
    private readonly describeMcpApproval: (call: ToolCall) => SecurityApprovalPreview | undefined = () => undefined,
    private readonly identifyMcpGrant: (call: ToolCall) => string | undefined = mcpToolGrantKey
  ) {}

  async check(
    call: ToolCall,
    context: { sessionId: string; workingDirectory: string }
  ): Promise<PermissionDecision> {
    if (call.name === 'load_skill'
      || call.name === 'mcp_tool_manifest'
      || call.name === 'mcp_tool_describe'
      || call.name === 'mcp_list_resources'
      || call.name === 'mcp_list_prompts') return { decision: 'allow' };
    if (call.name === 'install_skill') {
      const request: ApprovalRequest = {
        requestId: crypto.randomUUID(),
        sessionId: context.sessionId,
        call,
        reason: 'Install Agent Skills into the current workspace'
      };
      return { decision: 'ask', request };
    }
    if (!call.name.startsWith('mcp__')
      && call.name !== 'mcp_tool_call'
      && call.name !== 'mcp_read_resource'
      && call.name !== 'mcp_get_prompt') return this.base.check(call, context);
    const grantKey = mcpToolGrantKey(call) ? this.identifyMcpGrant(call) : undefined;
    if (grantKey && this.sessionGrants.has(context.sessionId, grantKey)) return { decision: 'allow' };
    const security = this.describeMcpApproval(call);
    if (security?.kind === 'mcp' && security.risk === 'read') return { decision: 'allow' };
    const request: ApprovalRequest = {
      requestId: crypto.randomUUID(),
      sessionId: context.sessionId,
      call,
      reason: call.name === 'mcp_read_resource' ? 'Read an untrusted MCP resource'
        : call.name === 'mcp_get_prompt' ? 'Load an untrusted MCP prompt'
          : 'Run an external MCP tool',
      ...(security ? { security } : {}),
      ...(grantKey ? {
        grant: { kind: 'mcp_tool' as const, key: grantKey, options: ['once', 'similar', 'conversation'] as const }
      } : {})
    };
    return { decision: 'ask', request };
  }
}
