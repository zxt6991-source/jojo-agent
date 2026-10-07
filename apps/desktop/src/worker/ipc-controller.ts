import type { JojoAppService } from '@desktop-agent/app-service';
import type { ChannelDeliveryReceipt, DesktopChannelMutation, MemoryStatusSnapshot, WorkerCommand } from '@desktop-agent/contracts';
import {
  serializedIpcBytes,
  WorkerCommandSchema,
  type ChannelSettingsSnapshot,
  type FileAttachment,
  type HookRuntime, type ImageContentBlock,
  type ModelSelection,
  type ProviderSettings,
  type WorkerMessage
} from '@desktop-agent/contracts';
import type { ApplicationContext } from '@desktop-agent/contracts/application';
import {
  McpManager
} from '@desktop-agent/extensions';
import {
  MemoryCandidateService,
  MemoryService
} from '@desktop-agent/memory';
import {
  TeamManager,
  WorkflowManager
} from '@desktop-agent/orchestration';
import {
  MemoryPermissionGrantStore
} from '@desktop-agent/permission-governance';
import type {
  CreateScheduleInput
} from '@desktop-agent/scheduler';
import { SqliteAgentRuntimeStore } from '@desktop-agent/storage/sqlite-runtime-store';
import { DesktopApprovalBroker } from './approval-broker';
import { UtilityModelBrowserHealingAdapter } from './browser-healing';
import { BrowserToolBridge } from './browser-tools';
import type { DesktopSchedulerRuntime } from './scheduler-runtime';
import { InteractiveTerminalSecretBroker } from './terminal-secret-broker';

interface Context {
  parentPort: ParentPort;
  sessionController: { handle(command: WorkerCommand): boolean };
  desktopChannelSecrets: Record<string, string>;
  extensionReady: Promise<void>;
  applyRuntimeConfig: (settings: ProviderSettings, apiKeys: Record<string, string>, mcpOAuthCredentials: Record<string, unknown>, terminalSecrets: Record<string, string>) => Promise<void>;
  post: (message: WorkerMessage) => void;
  launchTurn: (sessionId: string, text: string, images: ImageContentBlock[], providerId: string, model: string, files: FileAttachment[]) => void;
  controllers: Map<string, AbortController>;
  terminalSecretBroker: InteractiveTerminalSecretBroker;
  approvals: DesktopApprovalBroker;
  prepareTranscript: (sessionId: string, forExecution?: boolean) => Promise<void>;
  stopSession: (sessionId: string) => Promise<void>;
  permissionGrantStore: MemoryPermissionGrantStore;
  workflowManager: WorkflowManager;
  reloadOrchestrationAssets: (projectRoot?: string) => Promise<void>;
  desktopApplication: Promise<JojoAppService>;
  desktopContext: ApplicationContext;
  mcpManager: McpManager;
  postOAuthError: (requestId: string, error: unknown) => void;
  runtime: { settings: ProviderSettings; apiKeys: Record<string, string> } | null;
  agentRuntimeStore: SqliteAgentRuntimeStore;
  utilityCompletion: (selection: ModelSelection, prompt: string, signal: AbortSignal, maxOutputTokens: number, usageContext?: { sessionId: string; operationId?: string; cause: 'memory_candidate' | 'browser_heal' }) => Promise<string>;
  browserBridge: BrowserToolBridge;
  sessionHookRuntimes: Map<string, HookRuntime>;
  teamReady: Promise<void>;
  teamManager: TeamManager;
  schedulerReady: Promise<DesktopSchedulerRuntime>;
  compactScheduleInput: (input: object) => CreateScheduleInput;
  channelSnapshot: () => Promise<ChannelSettingsSnapshot>;
  mutateChannel: (input: DesktopChannelMutation) => Promise<ChannelDeliveryReceipt | ChannelSettingsSnapshot>;
  memoryReady: Promise<void | undefined>;
  memoryStatus: (workingDirectory?: string) => Promise<MemoryStatusSnapshot>;
  memoryService: MemoryService;
  memoryCandidateService: MemoryCandidateService;
}

export function bindWorkerIpc(ctx: Context): void {
  ctx.parentPort.on('message', (event) => {
    const parsed = WorkerCommandSchema.safeParse(event.data);
    if (!parsed.success) {
      const raw = event.data;
      console.warn('IPC protocol violation', {
        direction: 'main_to_worker',
        messageType: raw && typeof raw === 'object' && 'type' in raw && typeof raw.type === 'string' ? raw.type : 'unknown',
        issuePaths: parsed.error.issues.slice(0, 5).map((issue) => issue.path.map(String).join('.')),
        serializedSize: serializedIpcBytes(raw)
      });
      return;
    }
    const command = parsed.data;
    if (ctx.sessionController.handle(command)) return;
    if (command.type === 'config.update') {
      ctx.desktopChannelSecrets = { ...command.channelSecrets };
      ctx.extensionReady = ctx.extensionReady.then(
        () => ctx.applyRuntimeConfig(command.settings, command.apiKeys, command.mcpOAuthCredentials, command.terminalSecrets)
      ).catch((error) => {
        ctx.post({ type: 'worker.error', message: error instanceof Error ? error.message : String(error) });
      });
    }
    else if (command.type === 'turn.start') ctx.launchTurn(command.payload.sessionId, command.payload.text, command.payload.images, command.payload.providerId, command.payload.model, command.payload.files);
    else if (command.type === 'turn.cancel') {
      ctx.controllers.get(command.sessionId)?.abort();
      ctx.terminalSecretBroker.cancelSession(command.sessionId);
      void ctx.approvals.interruptSession(command.sessionId).catch(error => console.warn('Failed to interrupt approvals', error));
    } else if (command.type === 'terminal.secret.resolve') {
      ctx.terminalSecretBroker.resolveRequest(command.requestId, command.value);
    } else if (command.type === 'session.prepare') {
      void ctx.prepareTranscript(command.sessionId).then(() => ctx.post({
        type: 'session.prepared', requestId: command.requestId, sessionId: command.sessionId, ok: true
      })).catch((error) => ctx.post({
        type: 'session.prepared', requestId: command.requestId, sessionId: command.sessionId, ok: false,
        error: error instanceof Error ? error.message : String(error)
      }));
    } else if (command.type === 'session.stop') {
      void ctx.stopSession(command.sessionId)
        .then(() => {
          ctx.permissionGrantStore.clearSession(command.sessionId);
          ctx.post({ type: 'session.stopped', requestId: command.requestId, sessionId: command.sessionId, ok: true });
        })
        .catch((error) => ctx.post({
          type: 'session.stopped', requestId: command.requestId, sessionId: command.sessionId, ok: false,
          error: error instanceof Error ? error.message : String(error)
        }));
    } else if (command.type === 'workflow.cancel') {
      const workflow = ctx.workflowManager.get(command.workflowId);
      if (workflow?.sessionId === command.sessionId) ctx.workflowManager.cancel(command.workflowId);
    } else if (command.type === 'workflow.resume') {
      void ctx.extensionReady.then(() => {
        const workflow = ctx.workflowManager.get(command.workflowId);
        if (!workflow || workflow.sessionId !== command.sessionId) throw new Error(`Workflow not found: ${command.workflowId}`);
        const workingDirectory = ctx.workflowManager.workingDirectory(command.workflowId);
        if (!workingDirectory) throw new Error(`Workflow working directory is unavailable: ${command.workflowId}`);
        return ctx.reloadOrchestrationAssets(workingDirectory);
      }).then(() => {
        ctx.workflowManager.resume(command.workflowId);
        ctx.post({ type: 'workflow.action.result', requestId: command.requestId, ok: true });
      }).catch((error) => ctx.post({
        type: 'workflow.action.result', requestId: command.requestId, ok: false,
        error: error instanceof Error ? error.message : String(error)
      }));
    } else if (command.type === 'approval.resolve') {
      void ctx.desktopApplication.then(async app => {
        const pending = ctx.approvals.get(command.requestId);
        if (!pending) return;
        await app.resolveApproval(ctx.desktopContext, command.requestId, command.allow ? 'allow' : 'deny');
        if (pending.request.governance && command.allow && !pending.request.governance.locked
          && (command.scope === 'session' || command.scope === 'similar' || command.scope === 'conversation')) {
          ctx.permissionGrantStore.grantApproval(
            pending.request.sessionId,
            pending.request.governance.requestFingerprint,
            command.scope === 'session' ? 'similar' : command.scope
          );
        }
      }).catch(error => console.warn('Failed to resolve approval', error));
    } else if (command.type === 'mcp.oauth.start') {
      void ctx.extensionReady.then(
        () => ctx.mcpManager.startOAuth(command.serverId, command.requestId, command.redirectUrl, command.state)
      )
        .then((result) => { if (result === 'complete') ctx.post({ type: 'mcp.oauth.result', requestId: command.requestId, ok: true }); })
        .catch((error) => ctx.postOAuthError(command.requestId, error));
    } else if (command.type === 'mcp.oauth.callback') {
      void ctx.extensionReady.then(
        () => ctx.mcpManager.finishOAuth(command.requestId, command.serverId, new URLSearchParams(command.callbackParams))
      )
        .then(() => ctx.post({ type: 'mcp.oauth.result', requestId: command.requestId, ok: true }))
        .catch((error) => ctx.postOAuthError(command.requestId, error));
    } else if (command.type === 'mcp.oauth.disconnect') {
      void ctx.extensionReady.then(() => ctx.mcpManager.disconnectOAuth(command.serverId))
        .then(() => ctx.post({ type: 'mcp.oauth.result', requestId: command.requestId, ok: true }))
        .catch((error) => ctx.postOAuthError(command.requestId, error));
    } else if (command.type === 'mcp.reconnect') {
      void ctx.extensionReady.then(() => ctx.mcpManager.reconnect(command.serverId))
        .then(() => ctx.post({ type: 'mcp.oauth.result', requestId: command.requestId, ok: true }))
        .catch((error) => ctx.postOAuthError(command.requestId, error));
    } else if (command.type === 'mcp.trust') {
      void ctx.extensionReady.then(() => ctx.mcpManager.trust(command.serverId))
        .then(() => ctx.post({ type: 'mcp.oauth.result', requestId: command.requestId, ok: true }))
        .catch((error) => ctx.postOAuthError(command.requestId, error));
    } else if (command.type === 'mcp.trust.revoke') {
      void ctx.extensionReady.then(() => ctx.mcpManager.revokeTrust(command.serverId))
        .then(() => ctx.post({ type: 'mcp.oauth.result', requestId: command.requestId, ok: true }))
        .catch((error) => ctx.postOAuthError(command.requestId, error));
    } else if (command.type === 'browser.heal.request') {
      const signal = ctx.controllers.get(command.sessionId)?.signal ?? new AbortController().signal;
      const adapter = new UtilityModelBrowserHealingAdapter(async (prompt, healSignal) => {
        if (!ctx.runtime) throw new Error('Provider settings are unavailable.');
        const operationId = (await ctx.agentRuntimeStore.getLane(command.sessionId, 'main'))?.currentOperationId;
        return ctx.utilityCompletion(ctx.runtime.settings.utilityModel, prompt, healSignal, 512, {
          sessionId: command.sessionId,
          ...(operationId ? { operationId } : {}),
          cause: 'browser_heal'
        });
      });
      void adapter.heal(command.request, signal)
        .then((proposal) => ctx.post({ type: 'browser.heal.result', requestId: command.requestId, proposal }))
        .catch((error) => ctx.post({
          type: 'browser.heal.result', requestId: command.requestId,
          error: error instanceof Error ? error.message : String(error)
        }));
    } else if (command.type === 'browser.progress') {
      ctx.browserBridge.progress(command.requestId, command.text);
    } else if (command.type === 'browser.result') {
      ctx.browserBridge.resolve(command.requestId, command.result, command.error);
    } else if (command.type === 'hooks.invalidate') {
      ctx.sessionHookRuntimes.clear();
      ctx.post({ type: 'hooks.invalidated', requestId: command.requestId, ok: true });
    } else if (command.type === 'team.list') {
      void ctx.teamReady
        .then(() => ctx.teamManager.list(command.workspace))
        .then((teams) => ctx.post({ type: 'team.result', requestId: command.requestId, ok: true, teams }))
        .catch((error) => ctx.post({
          type: 'team.result', requestId: command.requestId, ok: false,
          error: error instanceof Error ? error.message : String(error)
        }));
    } else if (command.type === 'team.status') {
      void ctx.teamReady
        .then(() => ctx.teamManager.status(command.teamId))
        .then((status) => ctx.post({ type: 'team.result', requestId: command.requestId, ok: true, status }))
        .catch((error) => ctx.post({
          type: 'team.result', requestId: command.requestId, ok: false,
          error: error instanceof Error ? error.message : String(error)
        }));
    } else if (command.type === 'team.save') {
      void ctx.teamReady.then(async () => {
        const now = new Date().toISOString();
        const definition = {
          id: command.input.id,
          name: command.input.name,
          ...(command.input.description ? { description: command.input.description } : {}),
          workspace: command.input.workspace,
          members: command.input.members,
          maxConcurrency: command.input.maxConcurrency,
          createdAt: now,
          updatedAt: now
        };
        const existing = await ctx.teamManager.get(definition.id);
        return existing
          ? ctx.teamManager.update(definition, command.input.expectedRevision)
          : ctx.teamManager.create(definition);
      }).then((team) => ctx.post({ type: 'team.result', requestId: command.requestId, ok: true, team }))
        .catch((error) => ctx.post({
          type: 'team.result', requestId: command.requestId, ok: false,
          error: error instanceof Error ? error.message : String(error)
        }));
    } else if (command.type === 'team.delete') {
      void ctx.teamReady
        .then(() => ctx.teamManager.delete(command.teamId))
        .then(() => ctx.post({ type: 'team.result', requestId: command.requestId, ok: true }))
        .catch((error) => ctx.post({
          type: 'team.result', requestId: command.requestId, ok: false,
          error: error instanceof Error ? error.message : String(error)
        }));
    } else if (command.type === 'team.member.enabled') {
      void ctx.teamReady
        .then(() => command.enabled
          ? ctx.teamManager.enableMember(command.teamId, command.memberId)
          : ctx.teamManager.disableMember(command.teamId, command.memberId))
        .then(() => ctx.teamManager.get(command.teamId))
        .then((team) => ctx.post({ type: 'team.result', requestId: command.requestId, ok: true, ...(team ? { team } : {}) }))
        .catch((error) => ctx.post({
          type: 'team.result', requestId: command.requestId, ok: false,
          error: error instanceof Error ? error.message : String(error)
        }));
    } else if (command.type === 'scheduler.list') {
      void ctx.schedulerReady
        .then(({ service }) => service.list())
        .then((schedules) => ctx.post({ type: 'scheduler.result', requestId: command.requestId, ok: true, schedules }))
        .catch((error) => ctx.post({
          type: 'scheduler.result', requestId: command.requestId, ok: false,
          error: error instanceof Error ? error.message : String(error)
        }));
    } else if (command.type === 'scheduler.get') {
      void ctx.schedulerReady
        .then(({ service }) => service.get(command.scheduleId))
        .then((schedule) => ctx.post({ type: 'scheduler.result', requestId: command.requestId, ok: true, schedule }))
        .catch((error) => ctx.post({
          type: 'scheduler.result', requestId: command.requestId, ok: false,
          error: error instanceof Error ? error.message : String(error)
        }));
    } else if (command.type === 'scheduler.save') {
      void ctx.schedulerReady.then(({ service }) => {
        const { scheduleId, expectedRevision, ...input } = command.input;
        const compacted = ctx.compactScheduleInput(input);
        return scheduleId
          ? service.update(scheduleId, {
            ...compacted,
            ...(expectedRevision !== undefined ? { expectedRevision } : {})
          })
          : service.create(compacted, { id: 'desktop-user', type: 'user' });
      }).then((schedule) => ctx.post({ type: 'scheduler.result', requestId: command.requestId, ok: true, schedule }))
        .catch((error) => ctx.post({
          type: 'scheduler.result', requestId: command.requestId, ok: false,
          error: error instanceof Error ? error.message : String(error)
        }));
    } else if (command.type === 'scheduler.delete') {
      void ctx.schedulerReady
        .then(({ service }) => service.delete(command.scheduleId))
        .then(() => ctx.post({ type: 'scheduler.result', requestId: command.requestId, ok: true }))
        .catch((error) => ctx.post({
          type: 'scheduler.result', requestId: command.requestId, ok: false,
          error: error instanceof Error ? error.message : String(error)
        }));
    } else if (command.type === 'scheduler.enabled') {
      void ctx.schedulerReady
        .then(({ service }) => service.setEnabled(
          command.input.scheduleId,
          command.input.enabled,
          command.input.expectedRevision
        ))
        .then((schedule) => ctx.post({ type: 'scheduler.result', requestId: command.requestId, ok: true, schedule }))
        .catch((error) => ctx.post({
          type: 'scheduler.result', requestId: command.requestId, ok: false,
          error: error instanceof Error ? error.message : String(error)
        }));
    } else if (command.type === 'scheduler.run-now') {
      void ctx.schedulerReady
        .then(({ service }) => service.runNow(command.scheduleId))
        .then((run) => ctx.post({ type: 'scheduler.result', requestId: command.requestId, ok: true, run }))
        .catch((error) => ctx.post({
          type: 'scheduler.result', requestId: command.requestId, ok: false,
          error: error instanceof Error ? error.message : String(error)
        }));
    } else if (command.type === 'scheduler.runs.list') {
      void ctx.schedulerReady
        .then(({ service }) => service.listRuns(command.scheduleId, { limit: 100 }))
        .then((runs) => ctx.post({ type: 'scheduler.result', requestId: command.requestId, ok: true, runs }))
        .catch((error) => ctx.post({
          type: 'scheduler.result', requestId: command.requestId, ok: false,
          error: error instanceof Error ? error.message : String(error)
        }));
    } else if (command.type === 'scheduler.run.cancel') {
      void ctx.schedulerReady
        .then(({ service }) => service.cancelRun(command.runId))
        .then(() => ctx.post({ type: 'scheduler.result', requestId: command.requestId, ok: true }))
        .catch((error) => ctx.post({
          type: 'scheduler.result', requestId: command.requestId, ok: false,
          error: error instanceof Error ? error.message : String(error)
        }));
    } else if (command.type === 'channel.snapshot') {
      void ctx.channelSnapshot()
        .then((snapshot) => ctx.post({ type: 'channel.result', requestId: command.requestId, ok: true, snapshot }))
        .catch((error) => ctx.post({
          type: 'channel.result', requestId: command.requestId, ok: false,
          error: error instanceof Error ? error.message : String(error)
        }));
    } else if (command.type === 'channel.mutate') {
      void ctx.mutateChannel(command.input)
        .then((result) => 'deliveryId' in result
          ? ctx.post({ type: 'channel.result', requestId: command.requestId, ok: true, receipt: result })
          : ctx.post({ type: 'channel.result', requestId: command.requestId, ok: true, snapshot: result }))
        .catch((error) => ctx.post({
          type: 'channel.result', requestId: command.requestId, ok: false,
          error: error instanceof Error ? error.message : String(error)
        }));
    } else if (command.type === 'memory.status') {
      void ctx.memoryReady
        .then(() => ctx.memoryStatus(command.workingDirectory))
        .then((status) => ctx.post({ type: 'memory.result', requestId: command.requestId, ok: true, status }))
        .catch((error) => ctx.post({
          type: 'memory.result', requestId: command.requestId, ok: false,
          error: error instanceof Error ? error.message : String(error)
        }));
    } else if (command.type === 'memory.rebuild') {
      void ctx.memoryReady
        .then(() => ctx.memoryService.rebuild(command.scope, command.workingDirectory))
        .then(() => ctx.memoryStatus(command.workingDirectory))
        .then((status) => ctx.post({ type: 'memory.result', requestId: command.requestId, ok: true, status }))
        .catch((error) => ctx.post({
          type: 'memory.result', requestId: command.requestId, ok: false,
          error: error instanceof Error ? error.message : String(error)
        }));
    } else if (command.type === 'memory.semantic.rebuild') {
      void ctx.memoryReady
        .then(() => ctx.memoryService.rebuildSemantic(command.workingDirectory))
        .then(() => ctx.memoryStatus(command.workingDirectory))
        .then((status) => ctx.post({ type: 'memory.result', requestId: command.requestId, ok: true, status }))
        .catch((error) => ctx.post({
          type: 'memory.result', requestId: command.requestId, ok: false,
          error: error instanceof Error ? error.message : String(error)
        }));
    } else if (command.type === 'memory.delete') {
      void ctx.memoryReady
        .then(() => ctx.memoryService.deleteEntry(command.scope, command.entryId, command.workingDirectory))
        .then(() => ctx.memoryStatus(command.workingDirectory))
        .then((status) => ctx.post({ type: 'memory.result', requestId: command.requestId, ok: true, status }))
        .catch((error) => ctx.post({
          type: 'memory.result', requestId: command.requestId, ok: false,
          error: error instanceof Error ? error.message : String(error)
        }));
    } else if (command.type === 'memory.candidate.accept') {
      void ctx.memoryReady
        .then(() => ctx.memoryCandidateService.accept({
          id: command.candidateId,
          userConfirmed: command.userConfirmed,
          ...(command.workingDirectory ? { workingDirectory: command.workingDirectory } : {}),
          ...(command.edit ? { edit: command.edit } : {})
        }))
        .then(() => ctx.memoryStatus(command.workingDirectory))
        .then((status) => ctx.post({ type: 'memory.result', requestId: command.requestId, ok: true, status }))
        .catch((error) => ctx.post({ type: 'memory.result', requestId: command.requestId, ok: false, error: error instanceof Error ? error.message : String(error) }));
    } else if (command.type === 'memory.candidate.reject') {
      void ctx.memoryReady
        .then(() => ctx.memoryCandidateService.reject(command.candidateId))
        .then(() => ctx.memoryStatus(command.workingDirectory))
        .then((status) => ctx.post({ type: 'memory.result', requestId: command.requestId, ok: true, status }))
        .catch((error) => ctx.post({ type: 'memory.result', requestId: command.requestId, ok: false, error: error instanceof Error ? error.message : String(error) }));
    }
  });


}

type ParentPort = { on(event: 'message', listener: (event: { data: unknown }) => void): void; postMessage(message: WorkerMessage): void };
