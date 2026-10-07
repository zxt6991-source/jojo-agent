import {
  ApprovalInputSchema,
  IPC,
  MAX_IMAGE_ATTACHMENTS, MAX_IMAGE_BYTES,
  PermissionGovernanceSnapshotSchema,
  serializedIpcBytes,
  WorkerCommandSchema, WorkerMessageSchema,
  type AttachmentSelection, type BrowserHealProposal, type BrowserHealRequest, type ChannelDeliveryReceipt, type ChannelSettingsSnapshot, type ExtensionStatus, type MemoryStatusSnapshot, type PermissionGovernanceSnapshot, type ProviderSettings, type ScheduleContract, type ScheduleRunContract, type SessionCompactionRecord, type TeamSnapshot, type TeamStatusSnapshot, type WorkerCommand, type WorkerMessage, type WorkflowRunSnapshot
} from '@desktop-agent/contracts';
import { userSkillDirectories, type SkillDirectory } from '@desktop-agent/extensions';
import { FileHookTrustStore, loadHookSettings } from '@desktop-agent/hooks';
import { JsonConfigStore, SqlitePermissionGovernanceStore } from '@desktop-agent/storage';
import { SqliteAgentRuntimeStore } from '@desktop-agent/storage/sqlite-runtime-store';
import { app, BrowserWindow, ipcMain, nativeImage, safeStorage, shell, utilityProcess, type IpcMainInvokeEvent, type UtilityProcess } from 'electron';
import { access, cp, mkdir, readFile, rename, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { readRuntimeMessages } from '../runtime/transcript-reader';
import { mapChromeCdpError } from './browser-backends/chrome-cdp-client';
import { BrowserRuntime } from './browser-runtime';
import { registerAttachmentsIpc } from './ipc/attachments-ipc';
import { registerBrowserIpc } from './ipc/browser-ipc';
import { registerChannelIpc } from './ipc/channel-ipc';
import { registerExecutionIpc } from './ipc/execution-ipc';
import { registerExtensionsIpc } from './ipc/extensions-ipc';
import { registerHooksIpc } from './ipc/hooks-ipc';
import { registerMcpIpc } from './ipc/mcp-ipc';
import { registerMemoryIpc } from './ipc/memory-ipc';
import { registerSchedulerIpc } from './ipc/scheduler-ipc';
import { registerSecretsIpc } from './ipc/secrets-ipc';
import { SessionMetadataClient } from './ipc/session-client';
import { registerSessionMetadataIpc } from './ipc/session-ipc';
import { registerSettingsIpc } from './ipc/settings-ipc';
import { registerTeamIpc } from './ipc/team-ipc';
import { registerTranscriptIpc } from './ipc/transcript-ipc';
import { createDesktopSecrets } from './secrets/desktop-secrets';
import { SessionLifecycleManager } from './session-lifecycle';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

export function startDesktopHost(): void {
  const IMAGE_MIME_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

  async function importAttachmentPaths(paths: string[], mode: 'files' | 'folder'): Promise<AttachmentSelection> {
    return new Promise<AttachmentSelection>((resolve, reject) => {
      const importer = new Worker(path.join(currentDirectory, 'file-attachments-worker.js'), {
        workerData: { paths, mode },
        resourceLimits: { maxOldGenerationSizeMb: 512 }
      });
      const timeout = setTimeout(() => {
        reject(new Error('文件解析超时，请减少文件数量或选择较小的文件后重试。'));
        void importer.terminate();
      }, 60_000);
      importer.once('message', (selection: AttachmentSelection) => {
        clearTimeout(timeout);
        resolve(selection);
        void importer.terminate();
      });
      importer.once('error', (error) => { clearTimeout(timeout); reject(error); });
      importer.once('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`文件解析进程已退出（${code}），请减少文件大小后重试。`));
      });
    });
  }

  async function importTransferredPaths(paths: string[]): Promise<AttachmentSelection> {
    const images: NonNullable<AttachmentSelection['images']> = [];
    const documents: string[] = [];
    const warnings: string[] = [];
    for (const filePath of [...new Set(paths)]) {
      const mimeType = IMAGE_MIME_TYPES[path.extname(filePath).toLowerCase()];
      if (!mimeType) { documents.push(filePath); continue; }
      try {
        const info = await stat(filePath);
        if (info.isDirectory()) { documents.push(filePath); continue; }
        if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw new Error('图片必须小于 10 MB');
        if (images.length >= MAX_IMAGE_ATTACHMENTS) throw new Error('每条消息最多添加 4 张图片');
        if (nativeImage.createFromPath(filePath).isEmpty()) throw new Error('无法读取图片');
        images.push({ type: 'image', data: (await readFile(filePath)).toString('base64'), mimeType, name: path.basename(filePath) });
      } catch (cause) { warnings.push(`${path.basename(filePath)}：${cause instanceof Error ? cause.message : String(cause)}`); }
    }
    const selection = documents.length ? await importAttachmentPaths(documents, 'folder') : { files: [], warnings: [] };
    return { ...selection, images, warnings: [...warnings, ...selection.warnings] };
  }

  const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
  const e2eMode = process.env.JOJO_E2E === '1';
  const e2eDataDirectory = e2eMode ? process.env.JOJO_E2E_DATA_DIR : undefined;
  if (e2eDataDirectory) app.setPath('userData', e2eDataDirectory);
  if (e2eMode) app.disableHardwareAcceleration();
  if (e2eMode && process.platform === 'linux') app.commandLine.appendSwitch('password-store', 'basic');
  let mainWindow: BrowserWindow | null = null;
  let worker: UtilityProcess | null = null;
  let quitting = false;
  const sessionStore = new SessionMetadataClient(postWorkerCommand);
  let configStore: JsonConfigStore;
  let permissionGovernanceStore: SqlitePermissionGovernanceStore;
  let browserRuntime: BrowserRuntime | null = null;
  let secretPath: string;
  let legacySecretPath: string;
  let mcpOAuthSecretPath: string;
  let terminalSecretPath: string;
  let channelSecretPath: string;
  let runtimeDatabasePath: string;
  let extensionStatus: ExtensionStatus = { mcpServers: [], skills: [] };
  let visibleSkillPaths = new Map<string, ExtensionStatus['skills'][number]>();
  const oauthRequests = new Map<string, {
    serverId: string;
    state: string;
    server: Server;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const workerRequests = new Map<string, {
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const memoryRequests = new Map<string, {
    resolve: (status: MemoryStatusSnapshot) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const teamRequests = new Map<string, {
    resolve: (value: { teams?: TeamSnapshot[]; team?: TeamSnapshot; status?: TeamStatusSnapshot }) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  type SchedulerResponse = {
    schedules?: ScheduleContract[];
    schedule?: ScheduleContract;
    runs?: ScheduleRunContract[];
    run?: ScheduleRunContract;
  };
  const schedulerRequests = new Map<string, {
    resolve: (value: SchedulerResponse) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  type ChannelResponse = { snapshot?: ChannelSettingsSnapshot; receipt?: ChannelDeliveryReceipt };
  const channelRequests = new Map<string, {
    resolve: (value: ChannelResponse) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const workflowRuns = new Map<string, WorkflowRunSnapshot>();
  const browserSecretPrompts = new Map<string, { resolve: (value: string | undefined) => void }>();
  const terminalSecretRequests = new Map<string, { sessionId: string; name: string }>();
  const browserHealRequests = new Map<string, {
    resolve: (proposal: BrowserHealProposal) => void;
    reject: (error: Error) => void;
    cleanup: () => void;
  }>();
  const browserRequestControllers = new Map<string, AbortController>();
  let mcpOAuthCredentialWrite: Promise<void> = Promise.resolve();
  const sessionLifecycle = new SessionLifecycleManager();

  function protocolViolation(direction: 'main_to_worker' | 'worker_to_main', raw: unknown, issues: readonly { path: PropertyKey[] }[]): void {
    const messageType = raw && typeof raw === 'object' && 'type' in raw && typeof raw.type === 'string' ? raw.type : 'unknown';
    console.warn('IPC protocol violation', {
      direction,
      messageType,
      issuePaths: issues.slice(0, 5).map((issue) => issue.path.map(String).join('.')),
      serializedSize: serializedIpcBytes(raw)
    });
  }

  function postWorkerCommand(command: WorkerCommand): boolean {
    const parsed = WorkerCommandSchema.safeParse(command);
    if (!parsed.success) {
      protocolViolation('main_to_worker', command, parsed.error.issues);
      throw new Error('Main produced an invalid worker command.');
    }
    if (quitting) throw Object.assign(new Error('runtime_closing'), { code: 'runtime_closing' });
    if (!worker) return false;
    worker.postMessage(parsed.data);
    return true;
  }

  function permissionGovernanceSnapshot(input: {
    workingDirectory?: string;
    sessionId?: string;
    limit?: number;
  }): PermissionGovernanceSnapshot {
    return PermissionGovernanceSnapshotSchema.parse({
      global: permissionGovernanceStore.getProfile('global'),
      ...(input.workingDirectory
        ? { workspace: permissionGovernanceStore.getProfile('workspace', input.workingDirectory) }
        : {}),
      effective: permissionGovernanceStore.effectivePolicy(input.workingDirectory),
      recentDecisions: permissionGovernanceStore.listAudit({
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {})
      })
    });
  }

  function requestBrowserHeal(
    sessionId: string,
    request: BrowserHealRequest,
    signal: AbortSignal
  ): Promise<BrowserHealProposal> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const onAbort = () => finish(new Error('Browser self-heal was cancelled.'));
      const finish = (error?: Error, proposal?: BrowserHealProposal) => {
        const pending = browserHealRequests.get(requestId);
        if (!pending) return;
        browserHealRequests.delete(requestId);
        pending.cleanup();
        if (error || !proposal) reject(error ?? new Error('Browser self-heal returned no proposal.'));
        else resolve(proposal);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      browserHealRequests.set(requestId, {
        resolve: (proposal) => finish(undefined, proposal),
        reject: (error) => finish(error),
        cleanup: () => signal.removeEventListener('abort', onAbort)
      });
      if (signal.aborted) { onAbort(); return; }
      if (!postWorkerCommand({ type: 'browser.heal.request', requestId, sessionId, request })) {
        finish(new Error('Agent runtime is not available for browser self-heal.'));
      }
    });
  }

  function assertTrusted(event: IpcMainInvokeEvent): void {
    if (!mainWindow || event.sender.id !== mainWindow.webContents.id) throw new Error('Untrusted IPC sender.');
    const url = event.senderFrame?.url ?? '';
    if (!(url.startsWith('file://') || url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:'))) {
      throw new Error('Untrusted IPC origin.');
    }
  }

  async function listDesktopSessions() { return sessionStore.list(); }

  async function loadRuntimeTranscript(sessionId: string) {
    if (sessionLifecycle.state(sessionId) !== 'active' || !await sessionStore.get(sessionId)) return [];
    const snapshotStore = new SqliteAgentRuntimeStore(runtimeDatabasePath);
    try {
      if (snapshotStore.hasLegacyTranscriptCutover(sessionId)) return await readRuntimeMessages(snapshotStore, sessionId);
    } finally { snapshotStore.close(); }
    if (!worker) throw new Error('Agent runtime is not available.');
    const requestId = crypto.randomUUID();
    const completion = waitForWorker(requestId);
    if (!postWorkerCommand({ type: 'session.prepare', requestId, sessionId })) {
      finishWorkerRequest(requestId, new Error('Agent runtime is not available.'));
    }
    await completion;
    if (sessionLifecycle.state(sessionId) !== 'active' || !await sessionStore.get(sessionId)) return [];
    const runtimeStore = new SqliteAgentRuntimeStore(runtimeDatabasePath);
    try { return await readRuntimeMessages(runtimeStore, sessionId); }
    finally { runtimeStore.close(); }
  }

  async function loadSessionCompactions(sessionId: string): Promise<SessionCompactionRecord[]> {
    const runtimeStore = new SqliteAgentRuntimeStore(runtimeDatabasePath);
    try {
      const lane = await runtimeStore.getLane(sessionId, 'main');
      if (!lane) return [];
      return (await runtimeStore.readPath(lane.leafId)).flatMap((entry) => entry.type === 'compaction' ? [{
        id: entry.id,
        createdAt: new Date(entry.createdAt).toISOString(),
        summary: entry.summary,
        tokensBefore: entry.tokensBefore
      }] : []);
    } finally {
      runtimeStore.close();
    }
  }

  const { readApiKeys, saveApiKey, readMcpOAuthCredentials, readTerminalSecrets, saveTerminalSecret, readChannelSecrets, persistChannelSecrets, importTerminalSecretFromShell, updateMcpOAuthCredentials } = createDesktopSecrets({
    get secretPath() { return secretPath; },
    get legacySecretPath() { return legacySecretPath; },
    get mcpOAuthSecretPath() { return mcpOAuthSecretPath; },
    get terminalSecretPath() { return terminalSecretPath; },
    get channelSecretPath() { return channelSecretPath; }
  });
  async function pushConfig(): Promise<void> {
    const apiKeys = await readApiKeys();
    const settings = await configStore.get(apiKeys);
    const mcpOAuthCredentials = await readMcpOAuthCredentials();
    const terminalSecrets = await readTerminalSecrets();
    const channelSecrets = await readChannelSecrets();
    postWorkerCommand({ type: 'config.update', settings, apiKeys, mcpOAuthCredentials, terminalSecrets, channelSecrets });
  }

  function waitForWorker(requestId: string, timeoutMs = 120_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        workerRequests.delete(requestId);
        reject(new Error('Agent runtime request timed out.'));
      }, timeoutMs);
      workerRequests.set(requestId, { resolve, reject, timer });
    });
  }

  function finishWorkerRequest(requestId: string, error?: Error): void {
    const request = workerRequests.get(requestId);
    if (!request) return;
    workerRequests.delete(requestId);
    clearTimeout(request.timer);
    if (error) request.reject(error); else request.resolve();
  }

  function requestMemoryStatus(command: Extract<WorkerCommand, { type: 'memory.status' | 'memory.rebuild' | 'memory.semantic.rebuild' | 'memory.delete' | 'memory.candidate.accept' | 'memory.candidate.reject' }>): Promise<MemoryStatusSnapshot> {
    if (!worker) return Promise.reject(new Error('Agent runtime is not available.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        memoryRequests.delete(command.requestId);
        reject(new Error('Memory status request timed out.'));
      }, 30_000);
      memoryRequests.set(command.requestId, { resolve, reject, timer });
      postWorkerCommand(command);
    });
  }

  function finishMemoryRequest(message: Extract<WorkerMessage, { type: 'memory.result' }>): void {
    const request = memoryRequests.get(message.requestId);
    if (!request) return;
    memoryRequests.delete(message.requestId);
    clearTimeout(request.timer);
    if (!message.ok || !message.status) request.reject(new Error(message.error ?? 'Memory request failed.'));
    else request.resolve(message.status as MemoryStatusSnapshot);
  }

  function requestTeam(command: Extract<WorkerCommand, {
    type: 'team.list' | 'team.status' | 'team.save' | 'team.delete' | 'team.member.enabled'
  }>): Promise<{ teams?: TeamSnapshot[]; team?: TeamSnapshot; status?: TeamStatusSnapshot }> {
    if (!worker) return Promise.reject(new Error('Agent runtime is not available.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        teamRequests.delete(command.requestId);
        reject(new Error('Team request timed out.'));
      }, 30_000);
      teamRequests.set(command.requestId, { resolve, reject, timer });
      postWorkerCommand(command);
    });
  }

  function finishTeamRequest(message: Extract<WorkerMessage, { type: 'team.result' }>): void {
    const request = teamRequests.get(message.requestId);
    if (!request) return;
    teamRequests.delete(message.requestId);
    clearTimeout(request.timer);
    if (!message.ok) request.reject(new Error(message.error ?? 'Team request failed.'));
    else request.resolve({
      ...(message.teams ? { teams: message.teams as TeamSnapshot[] } : {}),
      ...(message.team ? { team: message.team as TeamSnapshot } : {}),
      ...(message.status ? { status: message.status as TeamStatusSnapshot } : {})
    });
  }

  function requestScheduler(command: Extract<WorkerCommand, {
    type: 'scheduler.list' | 'scheduler.get' | 'scheduler.save' | 'scheduler.delete' | 'scheduler.enabled'
    | 'scheduler.run-now' | 'scheduler.runs.list' | 'scheduler.run.cancel'
  }>): Promise<SchedulerResponse> {
    if (!worker) return Promise.reject(new Error('Agent runtime is not available.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        schedulerRequests.delete(command.requestId);
        reject(new Error('Scheduler request timed out.'));
      }, 30_000);
      schedulerRequests.set(command.requestId, { resolve, reject, timer });
      postWorkerCommand(command);
    });
  }

  function finishSchedulerRequest(message: Extract<WorkerMessage, { type: 'scheduler.result' }>): void {
    const request = schedulerRequests.get(message.requestId);
    if (!request) return;
    schedulerRequests.delete(message.requestId);
    clearTimeout(request.timer);
    if (!message.ok) request.reject(new Error(message.error ?? 'Scheduler request failed.'));
    else request.resolve({
      ...(message.schedules ? { schedules: message.schedules } : {}),
      ...(message.schedule ? { schedule: message.schedule } : {}),
      ...(message.runs ? { runs: message.runs } : {}),
      ...(message.run ? { run: message.run } : {})
    });
  }

  function requestChannel(command: Extract<WorkerCommand, { type: 'channel.snapshot' | 'channel.mutate' }>): Promise<ChannelResponse> {
    if (!worker) return Promise.reject(new Error('Agent runtime is not available.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        channelRequests.delete(command.requestId);
        reject(new Error('Channel request timed out.'));
      }, 30_000);
      channelRequests.set(command.requestId, { resolve, reject, timer });
      postWorkerCommand(command);
    });
  }

  function finishChannelRequest(message: Extract<WorkerMessage, { type: 'channel.result' }>): void {
    const request = channelRequests.get(message.requestId);
    if (!request) return;
    channelRequests.delete(message.requestId);
    clearTimeout(request.timer);
    if (!message.ok) request.reject(new Error(message.error ?? 'Channel request failed.'));
    else request.resolve({
      ...(message.snapshot ? { snapshot: message.snapshot as unknown as ChannelSettingsSnapshot } : {}),
      ...(message.receipt ? { receipt: message.receipt as unknown as ChannelDeliveryReceipt } : {})
    });
  }


  async function beginMcpOAuth(serverId: string): Promise<void> {
    if (!worker) throw new Error('Agent runtime is not available.');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Operating system secure storage is unavailable.');
    const requestId = crypto.randomUUID();
    const state = crypto.randomUUID();
    const callbackServer = createServer();
    const callbackReady = new Promise<string>((resolve, reject) => {
      callbackServer.once('error', reject);
      callbackServer.listen(0, '127.0.0.1', () => {
        const address = callbackServer.address();
        if (!address || typeof address === 'string') reject(new Error('Could not start OAuth callback listener.'));
        else resolve(`http://127.0.0.1:${address.port}/oauth/callback`);
      });
    });
    const redirectUrl = await callbackReady;
    const completion = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finishMcpOAuth(requestId, new Error('OAuth authorization timed out.')), 5 * 60_000);
      oauthRequests.set(requestId, { serverId, state, server: callbackServer, resolve, reject, timer });
    });
    callbackServer.on('request', (request, response) => {
      void (async () => {
        const pending = oauthRequests.get(requestId);
        if (!pending) return;
        const callback = new URL(request.url ?? '/', redirectUrl);
        const validPath = callback.pathname === '/oauth/callback';
        const validState = callback.searchParams.get('state') === pending.state;
        response.writeHead(validPath && validState ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
        response.end(validPath && validState
          ? '<!doctype html><meta charset="utf-8"><title>Authorized</title><h1>授权完成</h1><p>可以关闭此窗口并返回 Desktop Agent。</p>'
          : '<!doctype html><meta charset="utf-8"><title>Authorization failed</title><h1>授权失败</h1><p>OAuth 回调无效，请返回应用重试。</p>');
        if (!validPath || !validState) {
          if (validPath) finishMcpOAuth(requestId, new Error('OAuth callback state validation failed.'));
          return;
        }
        callbackServer.close();
        postWorkerCommand({
          type: 'mcp.oauth.callback', requestId, serverId,
          callbackParams: callback.searchParams.toString()
        });
      })().catch((error) => finishMcpOAuth(requestId, error instanceof Error ? error : new Error(String(error))));
    });
    postWorkerCommand({ type: 'mcp.oauth.start', requestId, serverId, redirectUrl, state });
    await completion;
  }

  function finishMcpOAuth(requestId: string, error?: Error): void {
    const pending = oauthRequests.get(requestId);
    if (!pending) return;
    oauthRequests.delete(requestId);
    clearTimeout(pending.timer);
    pending.server.close();
    if (error) pending.reject(error); else pending.resolve();
  }

  function sendToRenderer(channel: string, value?: unknown): void {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, value);
  }

  function promptBrowserSecret(input: { name: string; description?: string }): Promise<string | undefined> {
    return new Promise((resolve) => {
      const requestId = crypto.randomUUID();
      browserSecretPrompts.set(requestId, { resolve });
      sendToRenderer(IPC.browserSecretRequest, {
        requestId,
        name: input.name,
        ...(input.description ? { description: input.description } : {})
      });
      setTimeout(() => {
        const pending = browserSecretPrompts.get(requestId);
        if (!pending) return;
        browserSecretPrompts.delete(requestId);
        pending.resolve(undefined);
      }, 300_000);
    });
  }

  function skillDirectories(settings: ProviderSettings, workingDirectory?: string): SkillDirectory[] {
    return [
      ...(workingDirectory ? [
        { path: path.join(workingDirectory, '.codex', 'skills'), origin: 'project' as const },
        { path: path.join(workingDirectory, '.agents', 'skills'), origin: 'project' as const }
      ] : []),
      { path: path.join(app.getPath('userData'), 'skills'), origin: 'user' },
      ...userSkillDirectories().map((directory) => ({ path: directory, origin: 'user' as const })),
      ...settings.extensions.skills.directories.map((directory) => ({ path: directory, origin: 'custom' as const }))
    ];
  }

  async function refreshManagedSkills(): Promise<void> {
    await pushConfig();
    sendToRenderer(IPC.extensionsChanged);
  }

  function visibleSkill(filePath: string): ExtensionStatus['skills'][number] {
    const resolved = path.resolve(filePath);
    const skill = visibleSkillPaths.get(resolved);
    if (!skill) throw new Error('Skill 不存在或已不再可用。');
    return skill;
  }

  async function pathExists(filePath: string): Promise<boolean> {
    try { await access(filePath); return true; }
    catch { return false; }
  }

  const hookTrustStore = new FileHookTrustStore(path.join(os.homedir(), '.jojo', 'hooks-trust.json'));

  function userHookConfigPath(): string {
    return path.join(os.homedir(), '.jojo', 'hooks.yml');
  }

  function projectHookConfigPath(workingDirectory: string): string {
    return path.join(workingDirectory, '.jojo', 'hooks.yml');
  }

  async function readHookSnapshot(workingDirectory?: string) {
    return loadHookSettings({
      workingDirectory: workingDirectory ?? os.homedir(),
      includeProject: Boolean(workingDirectory),
      trustStore: hookTrustStore
    });
  }

  async function invalidateHookRuntimes(): Promise<void> {
    if (!worker) return;
    const requestId = crypto.randomUUID();
    const completion = waitForWorker(requestId);
    postWorkerCommand({ type: 'hooks.invalidate', requestId });
    await completion;
  }

  async function refreshHookSnapshot(workingDirectory?: string) {
    await invalidateHookRuntimes();
    return readHookSnapshot(workingDirectory);
  }

  async function replaceSkillDirectory(sourceRoot: string, destinationRoot: string): Promise<void> {
    if (path.resolve(sourceRoot) === path.resolve(destinationRoot)) throw new Error('导入源与目标 Skill 目录相同。');
    const parent = path.dirname(destinationRoot);
    const temporary = path.join(parent, `.skill-import-${crypto.randomUUID()}`);
    await mkdir(parent, { recursive: true });
    await cp(sourceRoot, temporary, { recursive: true, errorOnExist: true });
    if (await pathExists(destinationRoot)) await shell.trashItem(destinationRoot);
    await rename(temporary, destinationRoot);
  }

  function startWorker(): void {
    worker = utilityProcess.fork(path.join(currentDirectory, 'worker.js'), [], {
      serviceName: 'Desktop Agent Runtime',
      env: { ...process.env, DESKTOP_AGENT_DATA_DIR: app.getPath('userData') }
    });
    worker.on('message', (raw: unknown) => {
      const parsed = WorkerMessageSchema.safeParse(raw);
      if (!parsed.success) {
        protocolViolation('worker_to_main', raw, parsed.error.issues);
        return;
      }
      const message = parsed.data;
      if (message.type === 'ready') { /* Configuration was sent immediately after process start. */ }
      else if (message.type === 'agent.event') sendToRenderer(IPC.agentEvent, message.event);
      else if (message.type === 'orchestration.event') {
        if (message.event.type === 'workflow.changed') workflowRuns.set(message.event.workflow.id, message.event.workflow);
        sendToRenderer(IPC.orchestrationEvent, message.event);
      }
      else if (message.type === 'scheduler.event') sendToRenderer(IPC.scheduleEvent, message.event);
      else if (message.type === 'conversation.message.created') {
        sendToRenderer(IPC.conversationMessageCreated, message.event);
        sendToRenderer(IPC.sessionsChanged);
      }
      else if (message.type === 'session.metadata.result') sessionStore.accept(message);
      else if (message.type === 'session.prepared') {
        finishWorkerRequest(message.requestId, message.ok ? undefined : new Error(message.error ?? 'Session preparation failed.'));
      }
      else if (message.type === 'session.stopped') {
        finishWorkerRequest(message.requestId, message.ok ? undefined : new Error(message.error ?? 'Session stop failed.'));
      }
      else if (message.type === 'workflow.action.result') {
        finishWorkerRequest(message.requestId, message.ok ? undefined : new Error(message.error ?? 'Workflow action failed.'));
      }
      else if (message.type === 'sessions.changed') sendToRenderer(IPC.sessionsChanged);
      else if (message.type === 'extensions.status') {
        extensionStatus = message.status;
        sendToRenderer(IPC.extensionsChanged);
      }
      else if (message.type === 'mcp.oauth.authorization') {
        const pending = oauthRequests.get(message.requestId);
        let authorizationUrl: URL;
        try { authorizationUrl = new URL(message.url); }
        catch { finishMcpOAuth(message.requestId, new Error('OAuth server returned an invalid authorization URL.')); return; }
        if (!pending || !['http:', 'https:'].includes(authorizationUrl.protocol)) {
          finishMcpOAuth(message.requestId, new Error('OAuth authorization URL was rejected.'));
          return;
        }
        void shell.openExternal(authorizationUrl.toString()).catch((error) => finishMcpOAuth(message.requestId, error));
      }
      else if (message.type === 'mcp.oauth.credentials') {
        mcpOAuthCredentialWrite = mcpOAuthCredentialWrite.catch(() => undefined).then(
          () => updateMcpOAuthCredentials(message.serverId, message.credentials)
        );
      }
      else if (message.type === 'mcp.oauth.result') {
        void mcpOAuthCredentialWrite.then(() => {
          finishWorkerRequest(message.requestId, message.ok ? undefined : new Error(message.error ?? 'MCP OAuth operation failed.'));
          if (message.ok) finishMcpOAuth(message.requestId);
          else finishMcpOAuth(message.requestId, new Error(message.error ?? 'MCP OAuth authorization failed.'));
        }).catch((error) => finishMcpOAuth(message.requestId, error instanceof Error ? error : new Error(String(error))));
      }
      else if (message.type === 'terminal.secret.request') {
        void (async () => {
          const saved = (await readTerminalSecrets())[message.name];
          if (saved) {
            postWorkerCommand({ type: 'terminal.secret.resolve', requestId: message.requestId, value: saved });
            return;
          }
          terminalSecretRequests.set(message.requestId, { sessionId: message.sessionId, name: message.name });
          sendToRenderer(IPC.terminalSecretRequest, {
            requestId: message.requestId,
            name: message.name,
            ...(message.description ? { description: message.description } : {})
          });
        })().catch(() => postWorkerCommand({ type: 'terminal.secret.resolve', requestId: message.requestId }));
      }
      else if (message.type === 'browser.request') {
        const controller = new AbortController();
        browserRequestControllers.set(message.requestId, controller);
        void (async () => {
          if (!worker) return;
          sessionLifecycle.assertMutable(message.sessionId);
          if (!browserRuntime) throw new Error('Browser runtime is not available.');
          const settings = await configStore.get(await readApiKeys());
          if (!settings.extensions.browser.enabled) throw new Error('Browser tools are disabled in Settings.');
          const session = await sessionStore.get(message.sessionId);
          if (!session) throw new Error('Browser session does not exist.');
          try {
            const result = await browserRuntime.execute(
              message.sessionId,
              message.action,
              message.approved,
              settings.extensions.browser,
              session.workingDirectory,
              (text) => postWorkerCommand({ type: 'browser.progress', requestId: message.requestId, text }),
              controller.signal
            );
            postWorkerCommand({ type: 'browser.result', requestId: message.requestId, result });
          } catch (error) {
            postWorkerCommand({
              type: 'browser.result',
              requestId: message.requestId,
              error: mapChromeCdpError(error, settings.extensions.browser.chromeDebugPort).message
            });
          }
        })().finally(() => browserRequestControllers.delete(message.requestId)).catch((error) => postWorkerCommand({
          type: 'browser.result', requestId: message.requestId,
          error: error instanceof Error ? error.message : String(error)
        }));
      }
      else if (message.type === 'browser.cancel') {
        browserRequestControllers.get(message.requestId)?.abort(new DOMException('Cancelled', 'AbortError'));
      }
      else if (message.type === 'browser.heal.result') {
        const pending = browserHealRequests.get(message.requestId);
        if (pending) {
          if (message.error || !message.proposal) pending.reject(new Error(message.error ?? 'Browser self-heal returned no proposal.'));
          else pending.resolve(message.proposal);
        }
      }
      else if (message.type === 'worker.error') sendToRenderer(IPC.agentEvent, { type: 'turn.failed', code: 'worker_error', message: message.message });
      else if (message.type === 'hooks.invalidated') {
        finishWorkerRequest(message.requestId, message.ok ? undefined : new Error(message.error ?? 'Hook runtime reload failed.'));
      }
      else if (message.type === 'memory.result') finishMemoryRequest(message);
      else if (message.type === 'team.result') finishTeamRequest(message);
      else if (message.type === 'scheduler.result') finishSchedulerRequest(message);
      else if (message.type === 'channel.result') finishChannelRequest(message);
    });
    worker.on('exit', (code) => {
      sessionStore.close(new Error(quitting ? 'runtime_closing' : `Agent runtime exited (${code}).`), quitting);
      for (const requestId of workerRequests.keys()) {
        finishWorkerRequest(requestId, new Error(`Agent runtime exited (${code}).`));
      }
      for (const [requestId, request] of memoryRequests) {
        memoryRequests.delete(requestId);
        clearTimeout(request.timer);
        request.reject(new Error(`Agent runtime exited (${code}).`));
      }
      for (const [requestId, request] of teamRequests) {
        teamRequests.delete(requestId);
        clearTimeout(request.timer);
        request.reject(new Error(`Agent runtime exited (${code}).`));
      }
      for (const [requestId, request] of schedulerRequests) {
        schedulerRequests.delete(requestId);
        clearTimeout(request.timer);
        request.reject(new Error(`Agent runtime exited (${code}).`));
      }
      for (const [requestId, request] of channelRequests) {
        channelRequests.delete(requestId);
        clearTimeout(request.timer);
        request.reject(new Error(`Agent runtime exited (${code}).`));
      }
      for (const request of browserHealRequests.values()) request.reject(new Error(`Agent runtime exited (${code}).`));
      for (const controller of browserRequestControllers.values()) controller.abort(new Error(`Agent runtime exited (${code}).`));
      browserRequestControllers.clear();
      terminalSecretRequests.clear();
      if (!quitting) sendToRenderer(IPC.agentEvent, { type: 'turn.failed', code: 'worker_exit', message: `Agent runtime exited (${code}).` });
      worker = null;
      if (!quitting) setTimeout(startWorker, 1_000);
    });
    void pushConfig().catch((error) => sendToRenderer(IPC.agentEvent, {
      type: 'turn.failed',
      code: 'worker_config_error',
      message: error instanceof Error ? error.message : String(error)
    }));
  }

  function registerIpc(): void {
    registerSessionMetadataIpc({
      ipc: ipcMain, assertTrusted, client: sessionStore, lifecycle: sessionLifecycle,
      changed: () => sendToRenderer(IPC.sessionsChanged),
      deleted: sessionId => {
        for (const [id, workflow] of workflowRuns) if (workflow.sessionId === sessionId) workflowRuns.delete(id);
        for (const [id, request] of terminalSecretRequests) if (request.sessionId === sessionId) terminalSecretRequests.delete(id);
      }
    });
    registerTranscriptIpc({
      assertTrusted, loadRuntimeTranscript, loadSessionCompactions, sessionLifecycle, sessionStore,
      get mainWindow() { return mainWindow; }, listDesktopSessions
    });
    registerExecutionIpc({
      assertTrusted, sessionLifecycle,
      get worker() { return worker; }, sessionStore, postWorkerCommand, terminalSecretRequests, workflowRuns, waitForWorker
    });
    registerTeamIpc({ assertTrusted, requestTeam });
    registerSchedulerIpc({ assertTrusted, requestScheduler });
    registerChannelIpc({ assertTrusted, requestChannel, persistChannelSecrets, pushConfig });
    ipcMain.handle(IPC.resolveApproval, async (event, raw) => {
      assertTrusted(event); const input = ApprovalInputSchema.parse(raw);
      postWorkerCommand({ type: 'approval.resolve', ...input });
    });
    registerAttachmentsIpc({
      assertTrusted,
      get mainWindow() { return mainWindow; }, importAttachmentPaths, importTransferredPaths
    });
    registerSettingsIpc({
      assertTrusted,
      get configStore() { return configStore; }, readApiKeys, permissionGovernanceSnapshot,
      get permissionGovernanceStore() { return permissionGovernanceStore; }, pushConfig, saveApiKey
    });
    registerExtensionsIpc({
      assertTrusted, readApiKeys,
      get configStore() { return configStore; }, skillDirectories,
      get visibleSkillPaths() { return visibleSkillPaths; },
      set visibleSkillPaths(value) { visibleSkillPaths = value; },
      get extensionStatus() { return extensionStatus; }, visibleSkill, pathExists, refreshManagedSkills,
      get mainWindow() { return mainWindow; }, replaceSkillDirectory, pushConfig
    });
    registerMemoryIpc({
      assertTrusted, readApiKeys,
      get configStore() { return configStore; }, pushConfig, requestMemoryStatus
    });
    registerBrowserIpc({
      assertTrusted, sessionLifecycle,
      get browserRuntime() { return browserRuntime; },
      get configStore() { return configStore; }, readApiKeys
    });
    registerSecretsIpc({ assertTrusted, browserSecretPrompts, terminalSecretRequests, importTerminalSecretFromShell, saveTerminalSecret, postWorkerCommand, pushConfig });
    registerMcpIpc({
      assertTrusted, beginMcpOAuth,
      get worker() { return worker; }, waitForWorker, postWorkerCommand
    });
    registerHooksIpc({ assertTrusted, readHookSnapshot, refreshHookSnapshot, hookTrustStore, userHookConfigPath, projectHookConfigPath, pathExists });

  }

  function createWindow(): void {
    mainWindow = new BrowserWindow({
      width: 1280, height: 820, minWidth: 900, minHeight: 600, backgroundColor: '#111318',
      webPreferences: {
        preload: path.join(currentDirectory, 'preload.js'), nodeIntegration: false,
        contextIsolation: true, sandbox: true, webSecurity: true
      }
    });
    mainWindow.webContents.on('console-message', (details) => {
      const location = details.sourceId ? ` (${details.sourceId}:${details.lineNumber})` : '';
      const output = `[renderer:${details.level}] ${details.message}${location}`;
      if (details.level === 'error' || details.level === 'warning') console.error(output);
      else console.log(output);
    });
    mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
      console.error(`[renderer:load] ${code} ${description} ${url}`);
    });
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      console.error(`[renderer:gone] ${details.reason} (${details.exitCode})`);
    });
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.webContents.on('will-navigate', (event, url) => {
      const current = mainWindow?.webContents.getURL();
      if (current && new URL(url).origin !== new URL(current).origin) event.preventDefault();
    });
    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) void mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    else void mainWindow.loadFile(path.join(currentDirectory, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  if (!e2eMode && !app.requestSingleInstanceLock()) app.quit();
  else {
    if (!e2eMode) {
      app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
    }
    void app.whenReady().then(() => {
      if (e2eMode && process.platform === 'linux') safeStorage.setUsePlainTextEncryption(true);
      const dataDirectory = app.getPath('userData');
      configStore = new JsonConfigStore(path.join(dataDirectory, 'config.json'));
      permissionGovernanceStore = new SqlitePermissionGovernanceStore(path.join(dataDirectory, 'runtime', 'permissions.sqlite'));
      browserRuntime = new BrowserRuntime(dataDirectory, promptBrowserSecret, {
        window: () => mainWindow,
        onDock: (state) => sendToRenderer(IPC.browserDockState, state)
      }, (sessionId) => ({ heal: (request, signal) => requestBrowserHeal(sessionId, request, signal) }));
      secretPath = path.join(dataDirectory, 'secrets', 'provider-keys.bin');
      legacySecretPath = path.join(dataDirectory, 'secrets', 'provider-key.bin');
      mcpOAuthSecretPath = path.join(dataDirectory, 'secrets', 'mcp-oauth.bin');
      terminalSecretPath = path.join(dataDirectory, 'secrets', 'terminal-env.bin');
      channelSecretPath = path.join(dataDirectory, 'secrets', 'channel-secrets.bin');
      runtimeDatabasePath = path.join(dataDirectory, 'runtime', 'agent-runtime.sqlite');
      registerIpc(); startWorker(); createWindow();
    });
    app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
    app.on('before-quit', () => {
      quitting = true;
      sessionStore.close(Object.assign(new Error('runtime_closing'), { code: 'runtime_closing' }), true);
      for (const requestId of workerRequests.keys()) finishWorkerRequest(requestId, new Error('runtime_closing'));
      for (const requestId of oauthRequests.keys()) finishMcpOAuth(requestId, new Error('Application is closing.'));
      for (const pending of browserSecretPrompts.values()) pending.resolve(undefined);
      browserSecretPrompts.clear();
      terminalSecretRequests.clear();
      for (const request of browserHealRequests.values()) request.reject(new Error('Application is closing.'));
      for (const controller of browserRequestControllers.values()) controller.abort(new Error('Application is closing.'));
      browserRequestControllers.clear();
      browserRuntime?.close();
      permissionGovernanceStore?.close();
      worker?.kill();
    });
  }

}
