import type {
  ApprovalRequest,
  PermissionDecision,
  PermissionGate,
  ToolCall
} from '@desktop-agent/contracts';
import { ListFilesInput, ReadFileInput, TerminalInput } from './inputs.js';
import { resolveWorkspacePath } from './workspace-paths.js';

export class DefaultPermissionGate implements PermissionGate {
  async check(
    call: ToolCall,
    context: { sessionId: string; workingDirectory: string }
  ): Promise<PermissionDecision> {
    switch (call.name) {
      case 'terminal':
        return this.checkTerminal(call, context);
      case 'list_files':
        return this.checkListFiles(call, context.workingDirectory);
      case 'read_file':
        return this.checkReadFile(call, context);
      default:
        return { decision: 'deny', reason: `Unknown tool: ${call.name}` };
    }
  }

  private async checkTerminal(
    call: ToolCall,
    context: { sessionId: string; workingDirectory: string }
  ): Promise<PermissionDecision> {
    const parsed = TerminalInput.safeParse(call.input);
    if (!parsed.success) return { decision: 'deny', reason: parsed.error.message };

    try {
      const resolved = await resolveWorkspacePath(context.workingDirectory, parsed.data.cwd);
      if (!resolved.inside) {
        return {
          decision: 'deny',
          reason: 'Terminal cwd is outside the working directory.'
        };
      }

      return {
        decision: 'ask',
        request: this.createRequest(call, context.sessionId, 'Run a local command')
      };
    } catch (error) {
      return this.denyError(error);
    }
  }

  private async checkListFiles(call: ToolCall, workingDirectory: string): Promise<PermissionDecision> {
    const parsed = ListFilesInput.safeParse(call.input);
    if (!parsed.success) return { decision: 'deny', reason: parsed.error.message };

    try {
      const resolved = await resolveWorkspacePath(workingDirectory, parsed.data.path);
      return resolved.inside
        ? { decision: 'allow' }
        : { decision: 'deny', reason: 'Listing outside the working directory is not allowed.' };
    } catch (error) {
      return this.denyError(error);
    }
  }

  private async checkReadFile(
    call: ToolCall,
    context: { sessionId: string; workingDirectory: string }
  ): Promise<PermissionDecision> {
    const parsed = ReadFileInput.safeParse(call.input);
    if (!parsed.success) return { decision: 'deny', reason: parsed.error.message };

    try {
      const resolved = await resolveWorkspacePath(context.workingDirectory, parsed.data.path);
      return resolved.inside
        ? { decision: 'allow' }
        : {
            decision: 'ask',
            request: this.createRequest(
              call,
              context.sessionId,
              'Read a file outside the working directory'
            )
          };
    } catch (error) {
      return this.denyError(error);
    }
  }

  private createRequest(call: ToolCall, sessionId: string, reason: string): ApprovalRequest {
    return { requestId: crypto.randomUUID(), sessionId, call, reason };
  }

  private denyError(error: unknown): PermissionDecision {
    return {
      decision: 'deny',
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}
