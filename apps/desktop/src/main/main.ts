import { app, BrowserWindow, dialog, ipcMain, safeStorage, utilityProcess, type IpcMainInvokeEvent, type UtilityProcess } from 'electron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ApprovalInputSchema, CreateSessionInputSchema, IPC, ListModelsInputSchema, RenameSessionInputSchema, SaveSettingsInputSchema,
  SessionIdInputSchema, StartTurnInputSchema, isPlaceholderSessionTitle, sessionTitleFromPrompt,
  type WorkerCommand, type WorkerMessage
} from '@desktop-agent/contracts';
import { OpenAICompatibleProvider } from '@desktop-agent/providers';
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

function assertTrusted(event: IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) throw new Error('Untrusted IPC sender.');
  const url = event.senderFrame?.url ?? '';
  if (!(url.startsWith('file://') || url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:'))) {
    throw new Error('Untrusted IPC origin.');
  }
}

async function readApiKey(): Promise<string> {
  try {
    const encrypted = await readFile(secretPath);
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(encrypted) : '';
  } catch { return ''; }
}

async function saveApiKey(apiKey: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Operating system secure storage is unavailable.');
  await mkdir(path.dirname(secretPath), { recursive: true });
  await writeFile(secretPath, safeStorage.encryptString(apiKey), { mode: 0o600 });
}

async function pushConfig(): Promise<void> {
  const apiKey = await readApiKey();
  const settings = await configStore.get(Boolean(apiKey));
  worker?.postMessage({ type: 'config.update', settings, apiKey } satisfies WorkerCommand);
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
    if (isPlaceholderSessionTitle(session.title, session.workingDirectory)) {
      const messages = await sessionStore.messages(payload.sessionId);
      if (!messages.some((message) => message.role === 'user')) {
        await sessionStore.rename(payload.sessionId, sessionTitleFromPrompt(payload.text));
        sendToRenderer(IPC.sessionsChanged);
      }
    }
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
  ipcMain.handle(IPC.getSettings, async (event) => { assertTrusted(event); return configStore.get(Boolean(await readApiKey())); });
  ipcMain.handle(IPC.listModels, async (event, raw) => {
    assertTrusted(event);
    const input = ListModelsInputSchema.parse(raw);
    const apiKey = input.apiKey || await readApiKey();
    if (!apiKey) throw new Error('请先填写模型 API Key。');
    return new OpenAICompatibleProvider({ baseUrl: input.baseUrl, apiKey, timeoutMs: 15_000 }).listModels();
  });
  ipcMain.handle(IPC.saveSettings, async (event, raw) => {
    assertTrusted(event); const input = SaveSettingsInputSchema.parse(raw);
    if (input.apiKey) await saveApiKey(input.apiKey);
    await configStore.save({ baseUrl: input.baseUrl, model: input.model, models: input.models });
    await pushConfig(); return configStore.get(Boolean(await readApiKey()));
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
    secretPath = path.join(dataDirectory, 'secrets', 'provider-key.bin');
    registerIpc(); startWorker(); createWindow();
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  app.on('before-quit', () => { quitting = true; worker?.kill(); });
}
