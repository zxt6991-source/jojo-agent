import { preparePatch, prepareJournalMutation, patchPreview } from './patch-tools.js';
import os from 'node:os';
import path from 'node:path';
import { prepareSkillDraft, prepareSkillActivation } from './skill-draft-tools.js';
import { ResultReadInput } from './result-read-tool.js';
import { ShowArtifactInput } from './show-artifact-tool.js';
import type {
  ApprovalRequest,
  PermissionDecision,
  PermissionGate,
  ToolCall
} from '@desktop-agent/contracts';
import { GlobInput, GrepInput, ListFilesInput, ReadFileInput, TerminalInput, WebFetchInput, WebSearchInput } from './inputs.js';
import { FileSnapshotRegistry } from './file-snapshots.js';
import { mutationErrorCode, prepareFileMutation, mutationApprovalFingerprint } from './file-mutation.js';
import { parseHttpUrl, UnsafeWebUrlError } from './web-url.js';
import { isWebFetchSpillPath } from './web-fetch-storage.js';
import { resolveWorkspacePath } from './workspace-paths.js';
import { createProcessSandbox } from '@desktop-agent/process-sandbox';
import { DefaultTerminalSecurityPolicy, type TerminalSecurityPolicy } from './terminal-security-policy.js';
import { SessionSearchQuerySchema, SessionReadWindowQuerySchema, GeneratedDocumentSchema } from '@desktop-agent/contracts';

export class DefaultPermissionGate implements PermissionGate {
  constructor(
    private readonly snapshots = new FileSnapshotRegistry(),
    private readonly terminalPolicy: TerminalSecurityPolicy = new DefaultTerminalSecurityPolicy(createProcessSandbox('fallback')),
    private readonly journalDirectory: string = path.join(os.tmpdir(), 'desktop-agent-trash')
  ) {}

  async check(
    call: ToolCall,
    context: { sessionId: string; workingDirectory: string }
  ): Promise<PermissionDecision> {
    switch (call.name) {
      case 'apply_patch':
      case 'file_undo': {
        try {
          const mutations = call.name === 'apply_patch' ? await preparePatch(call.input, context.workingDirectory, this.snapshots) : (await prepareJournalMutation(call.input, context, this.journalDirectory)).mutations;
          this.snapshots.rememberMutationApproval(context.sessionId, call.id, mutationApprovalFingerprint(mutations));
          return { decision: 'ask', request: { ...this.createRequest(call, context.sessionId, `Review ${mutations.length} file changes`), preview: patchPreview(mutations) } };
        } catch (error) { return this.denyError(error); }
      }
      case 'skill_draft':
      case 'skill_activate': {
        try {
          const prepared = call.name === 'skill_draft' ? prepareSkillDraft(call.input, context.sessionId) : await prepareSkillActivation(call.input, context.workingDirectory);
          return this.checkFileMutation({ ...call, name: 'write_file', input: { path: prepared.path, content: prepared.content } }, context).then(decision => decision.decision === 'ask' ? { ...decision, request: { ...decision.request, call } } : decision);
        } catch (error) { return this.denyError(error); }
      }
      case 'session_search':
      case 'session_read_window': {
        const parsed = (call.name === 'session_search' ? SessionSearchQuerySchema : SessionReadWindowQuerySchema).safeParse(call.input);
        return parsed.success ? { decision: 'allow' } : { decision: 'deny', reason: parsed.error.message, code: 'invalid_input' };
      }
      case 'verification_profile':
        return call.input && typeof call.input === 'object' && !Array.isArray(call.input) && !Object.keys(call.input).length ? { decision: 'allow' } : { decision: 'deny', reason: 'Expected an empty object.', code: 'invalid_input' };
      case 'result_read': {
        const parsed = ResultReadInput.safeParse(call.input);
        return parsed.success ? { decision: 'allow' } : { decision: 'deny', reason: parsed.error.message, code: 'invalid_input' };
      }
      case 'create_document': {
        const parsed = GeneratedDocumentSchema.safeParse(call.input);
        return parsed.success ? { decision: 'allow' } : { decision: 'deny', reason: parsed.error.message, code: 'invalid_input' };
      }
      case 'show_artifact': {
        const parsed = ShowArtifactInput.safeParse(call.input);
        if (!parsed.success) return { decision: 'deny', reason: parsed.error.message };
        try {
          const resolved = await resolveWorkspacePath(context.workingDirectory, parsed.data.path);
          return resolved.inside ? { decision: 'allow' } : { decision: 'deny', reason: 'Artifact is outside the workspace.' };
        } catch (error) { return this.denyError(error); }
      }
      case 'terminal':
        return this.checkTerminal(call, context);
      case 'list_files':
        return this.checkListFiles(call, context.workingDirectory);
      case 'read_file':
        return this.checkReadFile(call, context);
      case 'glob':
      case 'grep':
        return this.checkSearch(call, context.workingDirectory);
      case 'web_search':
        return this.checkWebSearch(call);
      case 'web_fetch':
        return this.checkWebFetch(call);
      case 'write_file':
      case 'edit_file':
      case 'delete_file':
        return this.checkFileMutation(call, context);
      default:
        return { decision: 'deny', reason: `Unknown tool: ${call.name}` };
    }
  }

  private async checkSearch(call: ToolCall, workingDirectory: string): Promise<PermissionDecision> {
    const parsed = call.name === 'glob' ? GlobInput.safeParse(call.input) : GrepInput.safeParse(call.input);
    if (!parsed.success) return { decision: 'deny', reason: parsed.error.message, code: 'invalid_input' };
    try {
      const resolved = await resolveWorkspacePath(workingDirectory, parsed.data.path);
      if (resolved.inside) return { decision: 'allow' };
      if (call.name === 'grep' && await isWebFetchSpillPath(resolved.target)) return { decision: 'allow' };
      return { decision: 'deny', reason: 'Searching outside the working directory is not allowed.' };
    } catch (error) {
      return this.denyError(error);
    }
  }

  private checkWebSearch(call: ToolCall): PermissionDecision {
    const parsed = WebSearchInput.safeParse(call.input);
    if (!parsed.success) return { decision: 'deny', reason: parsed.error.message, code: 'invalid_input' };
    return { decision: 'allow' };
  }

  private checkWebFetch(call: ToolCall): PermissionDecision {
    const parsed = WebFetchInput.safeParse(call.input);
    if (!parsed.success) return { decision: 'deny', reason: parsed.error.message, code: 'invalid_input' };
    try {
      parseHttpUrl(parsed.data.url);
      return { decision: 'allow' };
    } catch (error) {
      return {
        decision: 'deny',
        reason: error instanceof Error ? error.message : String(error),
        code: error instanceof UnsafeWebUrlError ? error.code : 'unsafe_url'
      };
    }
  }

  private async checkFileMutation(
    call: ToolCall,
    context: { sessionId: string; workingDirectory: string }
  ): Promise<PermissionDecision> {
    try {
      const prepared = await prepareFileMutation(call, context.workingDirectory, this.snapshots);
      this.snapshots.rememberMutationApproval(context.sessionId, call.id, mutationApprovalFingerprint([prepared]));
      return {
        decision: 'ask',
        request: {
          ...this.createRequest(call, context.sessionId, `${prepared.kind} ${prepared.relativePath}`),
          preview: prepared.preview
        }
      };
    } catch (error) {
      return {
        decision: 'deny',
        reason: error instanceof Error ? error.message : String(error),
        code: mutationErrorCode(error)
      };
    }
  }

  private async checkTerminal(
    call: ToolCall,
    context: { sessionId: string; workingDirectory: string }
  ): Promise<PermissionDecision> {
    const parsed = TerminalInput.safeParse(call.input);
    if (!parsed.success) return { decision: 'deny', reason: parsed.error.message, code: 'invalid_input' };

    try {
      const plan = await this.terminalPolicy.plan(parsed.data, { workingDirectory: context.workingDirectory });
      return {
        decision: 'ask',
        request: {
          ...this.createRequest(call, context.sessionId, 'Run a local command'),
          security: {
            kind: 'terminal', command: plan.approval.executable,
            argumentsPreview: plan.approval.argumentsPreview, cwd: plan.approval.cwd,
            risk: plan.approval.risk, sandbox: plan.approval.sandboxStrength,
            network: plan.approval.network, secretEnv: plan.approval.secretEnv,
            capabilities: plan.approval.capabilities, reasons: plan.approval.reasons
          }
        }
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
      if (resolved.inside || await isWebFetchSpillPath(resolved.target)) return { decision: 'allow' };
      return {
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
