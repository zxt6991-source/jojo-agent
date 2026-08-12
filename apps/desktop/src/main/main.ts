import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, utilityProcess, type IpcMainInvokeEvent, type UtilityProcess } from 'electron';
import { createServer, type Server } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ApprovalInputSchema, CreateSessionInputSchema, GetExtensionStatusInputSchema, IPC, ListModelsInputSchema, McpServerIdInputSchema, RenameSessionInputSchema, SaveExtensionSettingsInputSchema, SaveSettingsInputSchema,
  SessionIdInputSchema, SkillPathInputSchema, StartTurnInputSchema,
  type ExtensionStatus, type WorkerCommand, type WorkerMessage
} from '@desktop-agent/contracts';
import { createProvider } from '@desktop-agent/providers';
import { discoverSkills, userSkillDirectories } from '@desktop-agent/extensions';
import { JsonConfigStore, JsonlSessionStore } from '@desktop-agent/storage';
import { collectWorkspaceChanges } from './workspace-changes';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let worker: UtilityProcess | null = null;
let quitting = false;
let sessionStore: JsonlSessionStore;
let configStore: JsonConfigStore;
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
const workerRequests = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
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
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
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
  const keys = await readApiKeys();
  keys[providerId] = apiKey;
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

function waitForWorker(requestId: string): Promise<void> {
  return new Promise((resolve, reject) => workerRequests.set(requestId, { resolve, reject }));
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

function startWorker(): void {
  worker = utilityProcess.fork(path.join(currentDirectory, 'worker.js'), [], {
    serviceName: 'Desktop Agent Runtime',
    env: { ...process.env, DESKTOP_AGENT_DATA_DIR: app.getPath('userData') }
  });
  worker.on('message', (message: WorkerMessage) => {
    if (message.type === 'ready') void pushConfig();
    else if (message.type === 'agent.event') sendToRenderer(IPC.agentEvent, message.event);
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
        const request = workerRequests.get(message.requestId);
        if (request) {
          workerRequests.delete(message.requestId);
          if (message.ok) request.resolve(); else request.reject(new Error(message.error ?? 'MCP OAuth operation failed.'));
        }
        if (message.ok) finishMcpOAuth(message.requestId);
        else finishMcpOAuth(message.requestId, new Error(message.error ?? 'MCP OAuth authorization failed.'));
      }).catch((error) => finishMcpOAuth(message.requestId, error instanceof Error ? error : new Error(String(error))));
    }
    else if (message.type === 'worker.error') sendToRenderer(IPC.agentEvent, { type: 'turn.failed', code: 'worker_error', message: message.message });
  });
  worker.on('exit', (code) => {
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
    worker?.postMessage({ type: 'turn.cancel', sessionId } satisfies WorkerCommand);
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
    if (!worker) throw new Error('Agent runtime is not available.');
    const session = await sessionStore.get(payload.sessionId);
    if (!session) throw new Error('Session not found.');
    worker.postMessage({ type: 'turn.start', payload } satisfies WorkerCommand);
  });
  ipcMain.handle(IPC.cancelTurn, async (event, raw) => {
    assertTrusted(event); const { sessionId } = SessionIdInputSchema.parse({ sessionId: raw });
    worker?.postMessage({ type: 'turn.cancel', sessionId } satisfies WorkerCommand);
  });
  ipcMain.handle(IPC.resolveApproval, async (event, raw) => {
    assertTrusted(event); const input = ApprovalInputSchema.parse(raw);
    worker?.postMessage({ type: 'approval.resolve', ...input } satisfies WorkerCommand);
  });
  ipcMain.handle(IPC.chooseDirectory, async (event) => {
    assertTrusted(event); const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
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
    const directories = [
      path.join(app.getPath('userData'), 'skills'),
      ...userSkillDirectories(),
      ...settings.extensions.skills.directories,
      ...(input.workingDirectory ? [
        path.join(input.workingDirectory, '.codex', 'skills'),
        path.join(input.workingDirectory, '.agents', 'skills')
      ] : [])
    ];
    const skills = (await discoverSkills(directories, settings.extensions.skills.disabled))
      .map(({ content: _content, ...status }) => status);
    visibleSkillPaths = new Map(skills.map((skill) => [skill.path, skill]));
    return { ...extensionStatus, skills };
  });
  ipcMain.handle(IPC.getSkillDetail, async (event, raw) => {
    assertTrusted(event);
    const input = SkillPathInputSchema.parse(raw);
    const skill = visibleSkillPaths.get(input.path);
    if (!skill) throw new Error('Skill 不存在或已不再可用。');
    const content = (await readFile(skill.path, 'utf8')).slice(0, 120_000);
    return { ...skill, content };
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
    worker?.kill();
  });
}
