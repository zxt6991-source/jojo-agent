import type {
  ApprovalRequest,
  PermissionDecision,
  PermissionGate,
  ToolCall
} from '@desktop-agent/contracts';

export class ExtensionPermissionGate implements PermissionGate {
  constructor(private readonly base: PermissionGate) {}

  async check(
    call: ToolCall,
    context: { sessionId: string; workingDirectory: string }
  ): Promise<PermissionDecision> {
    if (call.name === 'load_skill' || call.name === 'mcp_search_tools') return { decision: 'allow' };
    if (call.name === 'install_skill') {
      const request: ApprovalRequest = {
        requestId: crypto.randomUUID(),
        sessionId: context.sessionId,
        call,
        reason: 'Install Agent Skills into the current workspace'
      };
      return { decision: 'ask', request };
    }
    if (!call.name.startsWith('mcp__')) return this.base.check(call, context);
    const request: ApprovalRequest = {
      requestId: crypto.randomUUID(),
      sessionId: context.sessionId,
      call,
      reason: 'Run an external MCP tool'
    };
    return { decision: 'ask', request };
  }
}
