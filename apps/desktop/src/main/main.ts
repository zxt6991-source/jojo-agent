import { app, BrowserWindow, dialog, ipcMain, nativeImage, safeStorage, shell, utilityProcess, type IpcMainInvokeEvent, type UtilityProcess } from 'electron';
import { createServer, type Server } from 'node:http';
import { access, cp, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ApprovalInputSchema, BrowserDockActionSchema, BrowserDockLayoutSchema, CreateSessionInputSchema, CreateSkillInputSchema, GetExtensionStatusInputSchema, GetHookStatusInputSchema, HookProjectActionInputSchema, ImportSkillInputSchema, IPC, ListModelsInputSchema, MAX_IMAGE_ATTACHMENTS, MAX_IMAGE_BYTES, McpServerIdInputSchema, OpenHookConfigInputSchema, RenameSessionInputSchema, SaveExtensionSettingsInputSchema, SaveSettingsInputSchema,
  SessionIdInputSchema, SkillPathInputSchema, StartTurnInputSchema, UpdateSkillInputSchema, WorkflowRunActionInputSchema,
  type ExtensionStatus, type ProviderSettings, type WorkerCommand, type WorkerMessage, type WorkflowRunSnapshot
} from '@desktop-agent/contracts';
import { z } from 'zod';
import { createProvider } from '@desktop-agent/providers';
import { createSkillSource, discoverSkills, parseSkillSource, skillId, userSkillDirectories, type SkillDirectory } from '@desktop-agent/extensions';
import { EMPTY_HOOK_CONFIG, FileHookTrustStore, loadHookSettings } from '@desktop-agent/hooks';
import { JsonConfigStore, JsonlSessionStore } from '@desktop-agent/storage';
import { collectWorkspaceChanges } from './workspace-changes';
import { BrowserRuntime } from './browser-runtime';
import { mapChromeCdpError, probeChromeCdp } from './browser-backends/chrome-cdp-client';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let worker: UtilityProcess | null = null;
let quitting = false;
let sessionStore: JsonlSessionStore;
let configStore: JsonConfigStore;
let browserRuntime: BrowserRuntime | null = null;
let secretPath: string;
let legacySecretPath: string;
let mcpOAuthSecretPath: string;
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
const workflowRuns = new Map<string, WorkflowRunSnapshot>();
const browserSecretPrompts = new Map<string, { resolve: (value: string | undefined) => void }>();
let mcpOAuthCredentialWrite: Promise<void> = Promise.resolve();

function assertTrusted(event: IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) throw new Error('Untrusted IPC sender.');
  const url = event.senderFrame?.url ?? '';
  if (!(url.startsWith('file://') || url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:'))) {
    throw new Error('Untrusted IPC origin.');
  }
}

async function readApiKeys(): Promise<Record<string, string>> {
  try {
    const encrypted = await readFile(secretPath);
    if (!safeStorage.isEncryptionAvailable()) return {};
    const parsed: unknown = JSON.parse(safeStorage.decryptString(encrypted));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).flatMap(([id, value]) => {
      if (typeof value !== 'string' || !value.trim()) return [];
      return [[id, value.trim()]];
    }));
  } catch {
    try {
      const encrypted = await readFile(legacySecretPath);
      const key = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(encrypted) : '';
      return key ? { openai: key } : {};
    } catch { return {}; }
  }
}

async function saveApiKey(providerId: string, apiKey: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Operating system secure storage is unavailable.');
  const normalizedApiKey = apiKey.trim();
  if (!normalizedApiKey) throw new Error('API Key 不能为空。');
  const keys = await readApiKeys();
  keys[providerId] = normalizedApiKey;
  await mkdir(path.dirname(secretPath), { recursive: true });
  await writeFile(secretPath, safeStorage.encryptString(JSON.stringify(keys)), { mode: 0o600 });
}

async function readMcpOAuthCredentials(): Promise<Record<string, unknown>> {
  try {
    if (!safeStorage.isEncryptionAvailable()) return {};
    const encrypted = await readFile(mcpOAuthSecretPath);
    const parsed: unknown = JSON.parse(safeStorage.decryptString(encrypted));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

async function saveMcpOAuthCredentials(credentials: Record<string, unknown>): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Operating system secure storage is unavailable.');
  await mkdir(path.dirname(mcpOAuthSecretPath), { recursive: true });
  await writeFile(mcpOAuthSecretPath, safeStorage.encryptString(JSON.stringify(credentials)), { mode: 0o600 });
}

async function updateMcpOAuthCredentials(serverId: string, credentials: unknown): Promise<void> {
  const all = await readMcpOAuthCredentials();
  if (credentials && typeof credentials === 'object' && Object.keys(credentials).length > 0) all[serverId] = credentials;
  else delete all[serverId];
  await saveMcpOAuthCredentials(all);
}

async function pushConfig(): Promise<void> {
  const apiKeys = await readApiKeys();
  const settings = await configStore.get(apiKeys);
  const mcpOAuthCredentials = await readMcpOAuthCredentials();
  worker?.postMessage({ type: 'config.update', settings, apiKeys, mcpOAuthCredentials } satisfies WorkerCommand);
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

async function stopSessionRuntime(sessionId: string): Promise<void> {
  if (!worker) return;
  const requestId = crypto.randomUUID();
  const completion = waitForWorker(requestId);
  worker.postMessage({ type: 'session.stop', requestId, sessionId } satisfies WorkerCommand);
  await completion;
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
      worker?.postMessage({
        type: 'mcp.oauth.callback', requestId, serverId,
        callbackParams: callback.searchParams.toString()
      } satisfies WorkerCommand);
    })().catch((error) => finishMcpOAuth(requestId, error instanceof Error ? error : new Error(String(error))));
  });
  worker.postMessage({ type: 'mcp.oauth.start', requestId, serverId, redirectUrl, state } satisfies WorkerCommand);
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
  worker.postMessage({ type: 'hooks.invalidate', requestId } satisfies WorkerCommand);
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
  worker.on('message', (message: WorkerMessage) => {
    if (message.type === 'ready') void pushConfig();
    else if (message.type === 'agent.event') sendToRenderer(IPC.agentEvent, message.event);
    else if (message.type === 'orchestration.event') {
      if (message.event.type === 'workflow.changed') workflowRuns.set(message.event.workflow.id, message.event.workflow);
      sendToRenderer(IPC.orchestrationEvent, message.event);
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
    else if (message.type === 'browser.request') {
      void (async () => {
        if (!worker) return;
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
            session.workingDirectory
          );
          worker?.postMessage({ type: 'browser.result', requestId: message.requestId, result } satisfies WorkerCommand);
        } catch (error) {
          worker?.postMessage({
            type: 'browser.result',
            requestId: message.requestId,
            error: mapChromeCdpError(error, settings.extensions.browser.chromeDebugPort).message
          } satisfies WorkerCommand);
        }
      })().catch((error) => worker?.postMessage({
        type: 'browser.result', requestId: message.requestId,
        error: error instanceof Error ? error.message : String(error)
      } satisfies WorkerCommand));
    }
    else if (message.type === 'worker.error') sendToRenderer(IPC.agentEvent, { type: 'turn.failed', code: 'worker_error', message: message.message });
    else if (message.type === 'hooks.invalidated') {
      finishWorkerRequest(message.requestId, message.ok ? undefined : new Error(message.error ?? 'Hook runtime reload failed.'));
    }
  });
  worker.on('exit', (code) => {
    for (const requestId of workerRequests.keys()) {
      finishWorkerRequest(requestId, new Error(`Agent runtime exited (${code}).`));
    }
    sendToRenderer(IPC.agentEvent, { type: 'turn.failed', code: 'worker_exit', message: `Agent runtime exited (${code}).` });
    worker = null;
    if (!quitting) setTimeout(startWorker, 1_000);
  });
}

function registerIpc(): void {
  ipcMain.handle(IPC.listSessions, async (event) => { assertTrusted(event); return sessionStore.list(); });
  ipcMain.handle(IPC.createSession, async (event, raw) => {
    assertTrusted(event); const input = CreateSessionInputSchema.parse(raw);
    const session = await sessionStore.create(input.title, input.workingDirectory);
    sendToRenderer(IPC.sessionsChanged); return session;
  });
  ipcMain.handle(IPC.renameSession, async (event, raw) => {
    assertTrusted(event); const input = RenameSessionInputSchema.parse(raw);
    await sessionStore.rename(input.sessionId, input.title); sendToRenderer(IPC.sessionsChanged);
  });
  ipcMain.handle(IPC.deleteSession, async (event, raw) => {
    assertTrusted(event); const { sessionId } = SessionIdInputSchema.parse({ sessionId: raw });
    await stopSessionRuntime(sessionId);
    await sessionStore.delete(sessionId); sendToRenderer(IPC.sessionsChanged);
  });
  ipcMain.handle(IPC.loadMessages, async (event, raw) => {
    assertTrusted(event); const { sessionId } = SessionIdInputSchema.parse({ sessionId: raw });
    return sessionStore.messages(sessionId);
  });
  ipcMain.handle(IPC.getWorkspaceChanges, async (event, raw) => {
    assertTrusted(event); const { sessionId } = SessionIdInputSchema.parse({ sessionId: raw });
    const session = await sessionStore.get(sessionId);
    if (!session) throw new Error('Session not found.');
    return collectWorkspaceChanges(session.workingDirectory);
  });
  ipcMain.handle(IPC.startTurn, async (event, raw) => {
    assertTrusted(event); const payload = StartTurnInputSchema.parse(raw);
    for (const image of payload.images) {
      if (Buffer.byteLength(image.data, 'base64') > MAX_IMAGE_BYTES) throw new Error(`图片必须小于 10 MB：${image.name ?? 'image'}`);
    }
    if (!worker) throw new Error('Agent runtime is not available.');
    const session = await sessionStore.get(payload.sessionId);
    if (!session) throw new Error('Session not found.');
    worker.postMessage({ type: 'turn.start', payload } satisfies WorkerCommand);
  });
  ipcMain.handle(IPC.cancelTurn, async (event, raw) => {
    assertTrusted(event); const { sessionId } = SessionIdInputSchema.parse({ sessionId: raw });
    worker?.postMessage({ type: 'turn.cancel', sessionId } satisfies WorkerCommand);
  });
  ipcMain.handle(IPC.listWorkflowRuns, async (event, raw) => {
    assertTrusted(event); const { sessionId } = SessionIdInputSchema.parse({ sessionId: raw });
    return [...workflowRuns.values()]
      .filter((workflow) => workflow.sessionId === sessionId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  });
  ipcMain.handle(IPC.cancelWorkflow, async (event, raw) => {
    assertTrusted(event); const input = WorkflowRunActionInputSchema.parse(raw);
    worker?.postMessage({ type: 'workflow.cancel', ...input } satisfies WorkerCommand);
  });
  ipcMain.handle(IPC.resumeWorkflow, async (event, raw) => {
    assertTrusted(event); const input = WorkflowRunActionInputSchema.parse(raw);
    if (!worker) throw new Error('Agent runtime is not available.');
    const requestId = crypto.randomUUID();
    const completion = waitForWorker(requestId);
    worker.postMessage({ type: 'workflow.resume', requestId, ...input } satisfies WorkerCommand);
    await completion;
  });
  ipcMain.handle(IPC.resolveApproval, async (event, raw) => {
    assertTrusted(event); const input = ApprovalInputSchema.parse(raw);
    worker?.postMessage({ type: 'approval.resolve', ...input } satisfies WorkerCommand);
  });
  ipcMain.handle(IPC.chooseDirectory, async (event) => {
    assertTrusted(event); const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle(IPC.chooseImages, async (event) => {
    assertTrusted(event);
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '选择图片',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
    });
    if (result.canceled) return [];
    const mimeTypes: Record<string, `image/${string}`> = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif'
    };
    return Promise.all(result.filePaths.slice(0, MAX_IMAGE_ATTACHMENTS).map(async (filePath) => {
      const info = await stat(filePath);
      if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw new Error(`图片必须小于 10 MB：${path.basename(filePath)}`);
      const mimeType = mimeTypes[path.extname(filePath).toLowerCase()];
      if (!mimeType || nativeImage.createFromPath(filePath).isEmpty()) throw new Error(`不支持或无法读取图片：${path.basename(filePath)}`);
      return { type: 'image' as const, data: (await readFile(filePath)).toString('base64'), mimeType, name: path.basename(filePath) };
    }));
  });
  ipcMain.handle(IPC.getSettings, async (event) => { assertTrusted(event); return configStore.get(await readApiKeys()); });
  ipcMain.handle(IPC.listModels, async (event, raw) => {
    assertTrusted(event);
    const input = ListModelsInputSchema.parse(raw);
    const settings = await configStore.get(await readApiKeys());
    const configured = settings.providers.find((provider) => provider.protocol === input.protocol);
    const apiKey = input.apiKey || (configured ? (await readApiKeys())[configured.id] : undefined);
    if (!apiKey) throw new Error('请先填写模型 API Key。');
    return createProvider({
      id: configured?.id ?? 'discovery', name: configured?.name ?? 'Provider', protocol: input.protocol,
      baseUrl: input.baseUrl, model: configured?.model ?? 'discovery', models: configured?.models ?? ['discovery'],
      contextWindowTokens: configured?.contextWindowTokens ?? 128_000,
      maxOutputTokens: configured?.maxOutputTokens ?? 8_192, hasApiKey: true
    }, apiKey, 15_000).listModels();
  });
  ipcMain.handle(IPC.saveSettings, async (event, raw) => {
    assertTrusted(event); const input = SaveSettingsInputSchema.parse(raw);
    if (input.apiKey) await saveApiKey(input.provider.id, input.apiKey);
    const apiKeys = await readApiKeys();
    const current = await configStore.get(apiKeys);
    const provider = { ...input.provider, hasApiKey: Boolean(apiKeys[input.provider.id]) };
    const providers = current.providers.some((item) => item.id === provider.id)
      ? current.providers.map((item) => item.id === provider.id ? provider : item)
      : [...current.providers, provider];
    const settings = { activeProviderId: input.activeProviderId, providers, utilityModel: input.utilityModel, extensions: current.extensions };
    await configStore.save(settings);
    await pushConfig(); return configStore.get(apiKeys);
  });
  ipcMain.handle(IPC.getExtensionStatus, async (event, raw) => {
    assertTrusted(event);
    const input = GetExtensionStatusInputSchema.parse(raw ?? {});
    const apiKeys = await readApiKeys();
    const settings = await configStore.get(apiKeys);
    const skills = (await discoverSkills(skillDirectories(settings, input.workingDirectory), settings.extensions.skills.disabled))
      .map(({ content: _content, ...status }) => status);
    visibleSkillPaths = new Map(skills.map((skill) => [path.resolve(skill.path), skill]));
    return { ...extensionStatus, skills };
  });
  ipcMain.handle(IPC.getSkillDetail, async (event, raw) => {
    assertTrusted(event);
    const input = SkillPathInputSchema.parse(raw);
    const skill = visibleSkill(input.path);
    const content = (await readFile(skill.path, 'utf8')).slice(0, 120_000);
    return { ...skill, content };
  });
  ipcMain.handle(IPC.createSkill, async (event, raw) => {
    assertTrusted(event);
    const input = CreateSkillInputSchema.parse(raw);
    const root = path.join(app.getPath('userData'), 'skills', skillId(input.name));
    if (await pathExists(root)) throw new Error('同名用户 Skill 已存在，请打开后编辑或更新。');
    await mkdir(root, { recursive: true });
    await Promise.all(['scripts', 'templates', 'references'].map((name) => mkdir(path.join(root, name))));
    await writeFile(path.join(root, 'SKILL.md'), createSkillSource(input.name, input.description, input.instructions), { encoding: 'utf8', flag: 'wx' });
    await refreshManagedSkills();
    return { canceled: false, path: path.join(root, 'SKILL.md') };
  });
  ipcMain.handle(IPC.updateSkill, async (event, raw) => {
    assertTrusted(event);
    const input = UpdateSkillInputSchema.parse(raw);
    const skill = visibleSkill(input.path);
    parseSkillSource(skill.path, input.content);
    let destinationFile = skill.path;
    if (skill.origin === 'default') {
      const destinationRoot = path.join(app.getPath('userData'), 'skills', skill.id);
      if (!(await pathExists(destinationRoot))) await cp(skill.rootPath, destinationRoot, { recursive: true, errorOnExist: true });
      destinationFile = path.join(destinationRoot, 'SKILL.md');
    }
    await writeFile(destinationFile, input.content, 'utf8');
    await refreshManagedSkills();
    return { canceled: false, path: destinationFile };
  });
  ipcMain.handle(IPC.importSkill, async (event, raw) => {
    assertTrusted(event);
    const input = ImportSkillInputSchema.parse(raw ?? {});
    const selected = await dialog.showOpenDialog(mainWindow!, {
      title: input.replacePath ? '选择用于更新 Skill 的目录或 SKILL.md' : '导入 Skill',
      properties: ['openFile', 'openDirectory'],
      filters: [{ name: 'Agent Skill', extensions: ['md'] }]
    });
    if (selected.canceled || !selected.filePaths[0]) return { canceled: true };
    const selectedPath = selected.filePaths[0];
    const selectedInfo = await stat(selectedPath);
    const sourceRoot = selectedInfo.isDirectory() ? selectedPath : path.dirname(selectedPath);
    const sourceFile = path.join(sourceRoot, 'SKILL.md');
    const sourceInfo = await stat(sourceFile);
    if (!sourceInfo.isFile() || sourceInfo.size > 480_000) throw new Error('导入的 SKILL.md 过大。');
    const metadata = parseSkillSource(sourceFile, await readFile(sourceFile, 'utf8'));
    let destinationRoot = path.join(app.getPath('userData'), 'skills', metadata.id);
    if (input.replacePath) {
      const current = visibleSkill(input.replacePath);
      if (current.id !== metadata.id) throw new Error(`更新包的 Skill ID 为 ${metadata.id}，与当前 ${current.id} 不一致。`);
      if (current.origin !== 'default') destinationRoot = current.rootPath;
    } else if (await pathExists(destinationRoot)) {
      const confirmation = await dialog.showMessageBox(mainWindow!, {
        type: 'warning',
        buttons: ['更新现有 Skill', '取消'],
        defaultId: 0,
        cancelId: 1,
        message: `用户 Skill“${metadata.name}”已存在`,
        detail: '继续会将旧目录移入废纸篓，再导入新版本（包括 scripts、templates 和 references）。'
      });
      if (confirmation.response !== 0) return { canceled: true };
    }
    await replaceSkillDirectory(sourceRoot, destinationRoot);
    await refreshManagedSkills();
    return { canceled: false, path: path.join(destinationRoot, 'SKILL.md') };
  });
  ipcMain.handle(IPC.exportSkill, async (event, raw) => {
    assertTrusted(event);
    const input = SkillPathInputSchema.parse(raw);
    const skill = visibleSkill(input.path);
    const selected = await dialog.showSaveDialog(mainWindow!, {
      title: '导出 Skill 目录',
      defaultPath: path.join(app.getPath('downloads'), path.basename(skill.rootPath)),
      buttonLabel: '导出'
    });
    if (selected.canceled || !selected.filePath) return { canceled: true };
    if (await pathExists(selected.filePath)) throw new Error('导出目标已存在，请选择一个新目录。');
    await cp(skill.rootPath, selected.filePath, { recursive: true, errorOnExist: true });
    return { canceled: false, path: selected.filePath };
  });
  ipcMain.handle(IPC.trashSkill, async (event, raw) => {
    assertTrusted(event);
    const input = SkillPathInputSchema.parse(raw);
    const skill = visibleSkill(input.path);
    if (skill.origin === 'default') throw new Error('默认 Skill 不能删除；可创建同名用户 Skill 进行覆盖。');
    const expectedFile = path.join(skill.rootPath, 'SKILL.md');
    if (path.resolve(expectedFile) !== path.resolve(skill.path)) throw new Error('拒绝删除无效的 Skill 根目录。');
    await shell.trashItem(skill.rootPath);
    await refreshManagedSkills();
    return { canceled: false, path: skill.rootPath };
  });
  ipcMain.handle(IPC.saveExtensionSettings, async (event, raw) => {
    assertTrusted(event);
    const extensions = SaveExtensionSettingsInputSchema.parse(raw);
    const apiKeys = await readApiKeys();
    const current = await configStore.get(apiKeys);
    await configStore.save({ ...current, extensions });
    await pushConfig();
    return extensions;
  });
  ipcMain.handle(IPC.browserDockLayout, async (event, raw) => {
    assertTrusted(event);
    browserRuntime?.setDockLayout(BrowserDockLayoutSchema.parse(raw));
  });
  ipcMain.handle(IPC.browserDockAction, async (event, raw) => {
    assertTrusted(event);
    await browserRuntime?.handleDockAction(BrowserDockActionSchema.parse(raw));
  });
  ipcMain.handle(IPC.probeChromeBrowser, async (event, raw) => {
    assertTrusted(event);
    const settings = await configStore.get(await readApiKeys());
    const port = z.number().int().min(1).max(65_535).optional().parse(raw) ?? settings.extensions.browser.chromeDebugPort;
    try {
      const info = await probeChromeCdp(port);
      return { ok: true, browser: info.browser };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle(IPC.browserSecretResolve, async (event, raw) => {
    assertTrusted(event);
    const input = z.object({ requestId: z.string().min(1), value: z.string().max(4_000).optional() }).parse(raw);
    const pending = browserSecretPrompts.get(input.requestId);
    if (!pending) return;
    browserSecretPrompts.delete(input.requestId);
    pending.resolve(input.value?.trim() || undefined);
  });
  ipcMain.handle(IPC.connectMcpOAuth, async (event, raw) => {
    assertTrusted(event);
    const { serverId } = McpServerIdInputSchema.parse(raw);
    await beginMcpOAuth(serverId);
  });
  ipcMain.handle(IPC.disconnectMcpOAuth, async (event, raw) => {
    assertTrusted(event);
    const { serverId } = McpServerIdInputSchema.parse(raw);
    if (!worker) throw new Error('Agent runtime is not available.');
    const requestId = crypto.randomUUID();
    const completion = waitForWorker(requestId);
    worker.postMessage({ type: 'mcp.oauth.disconnect', requestId, serverId } satisfies WorkerCommand);
    await completion;
  });
  ipcMain.handle(IPC.reconnectMcp, async (event, raw) => {
    assertTrusted(event);
    const { serverId } = McpServerIdInputSchema.parse(raw);
    if (!worker) throw new Error('Agent runtime is not available.');
    const requestId = crypto.randomUUID();
    const completion = waitForWorker(requestId);
    worker.postMessage({ type: 'mcp.reconnect', requestId, serverId } satisfies WorkerCommand);
    await completion;
  });
  ipcMain.handle(IPC.getHookStatus, async (event, raw) => {
    assertTrusted(event);
    const input = GetHookStatusInputSchema.parse(raw ?? {});
    return readHookSnapshot(input.workingDirectory);
  });
  ipcMain.handle(IPC.reloadHooks, async (event, raw) => {
    assertTrusted(event);
    const input = GetHookStatusInputSchema.parse(raw ?? {});
    return refreshHookSnapshot(input.workingDirectory);
  });
  ipcMain.handle(IPC.trustProjectHooks, async (event, raw) => {
    assertTrusted(event);
    const { workingDirectory } = HookProjectActionInputSchema.parse(raw);
    const snapshot = await readHookSnapshot(workingDirectory);
    const project = snapshot.project;
    if (!project?.fingerprint) throw new Error('当前项目没有可信任的 Hooks 配置。');
    if (project.state === 'invalid') throw new Error(project.error ?? '项目 Hooks 配置无效。');
    await hookTrustStore.trust(project.path, project.fingerprint);
    return refreshHookSnapshot(workingDirectory);
  });
  ipcMain.handle(IPC.disableProjectHooks, async (event, raw) => {
    assertTrusted(event);
    const { workingDirectory } = HookProjectActionInputSchema.parse(raw);
    const snapshot = await readHookSnapshot(workingDirectory);
    const project = snapshot.project;
    if (!project || project.state === 'missing') throw new Error('当前项目尚未配置 Hooks。');
    await hookTrustStore.disable(project.path);
    return refreshHookSnapshot(workingDirectory);
  });
  ipcMain.handle(IPC.openHookConfig, async (event, raw) => {
    assertTrusted(event);
    const input = OpenHookConfigInputSchema.parse(raw);
    const file = input.source === 'user'
      ? userHookConfigPath()
      : projectHookConfigPath(input.workingDirectory!);
    await mkdir(path.dirname(file), { recursive: true });
    if (!(await pathExists(file))) await writeFile(file, EMPTY_HOOK_CONFIG, { encoding: 'utf8', flag: 'wx' });
    const error = await shell.openPath(file);
    if (error) throw new Error(error);
  });
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

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  void app.whenReady().then(() => {
    const dataDirectory = app.getPath('userData');
    sessionStore = new JsonlSessionStore(path.join(dataDirectory, 'sessions'));
    configStore = new JsonConfigStore(path.join(dataDirectory, 'config.json'));
    browserRuntime = new BrowserRuntime(dataDirectory, promptBrowserSecret, {
      window: () => mainWindow,
      onDock: (state) => sendToRenderer(IPC.browserDockState, state)
    });
    secretPath = path.join(dataDirectory, 'secrets', 'provider-keys.bin');
    legacySecretPath = path.join(dataDirectory, 'secrets', 'provider-key.bin');
    mcpOAuthSecretPath = path.join(dataDirectory, 'secrets', 'mcp-oauth.bin');
    registerIpc(); startWorker(); createWindow();
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  app.on('before-quit', () => {
    quitting = true;
    for (const requestId of oauthRequests.keys()) finishMcpOAuth(requestId, new Error('Application is closing.'));
    for (const pending of browserSecretPrompts.values()) pending.resolve(undefined);
    browserSecretPrompts.clear();
    browserRuntime?.close();
    worker?.kill();
  });
}
