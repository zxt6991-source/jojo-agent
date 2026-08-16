import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type AgentEvent, type BrowserDockState, type DesktopApi, type OrchestrationEvent } from '@desktop-agent/contracts';

const api: DesktopApi = {
  listSessions: () => ipcRenderer.invoke(IPC.listSessions),
  createSession: (input) => ipcRenderer.invoke(IPC.createSession, input),
  renameSession: (input) => ipcRenderer.invoke(IPC.renameSession, input),
  deleteSession: (sessionId) => ipcRenderer.invoke(IPC.deleteSession, sessionId),
  loadMessages: (sessionId) => ipcRenderer.invoke(IPC.loadMessages, sessionId),
  getWorkspaceChanges: (sessionId) => ipcRenderer.invoke(IPC.getWorkspaceChanges, sessionId),
  startTurn: (input) => ipcRenderer.invoke(IPC.startTurn, input),
  cancelTurn: (sessionId) => ipcRenderer.invoke(IPC.cancelTurn, sessionId),
  resolveApproval: (input) => ipcRenderer.invoke(IPC.resolveApproval, input),
  chooseDirectory: () => ipcRenderer.invoke(IPC.chooseDirectory),
  chooseImages: () => ipcRenderer.invoke(IPC.chooseImages),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  listModels: (input) => ipcRenderer.invoke(IPC.listModels, input),
  saveSettings: (input) => ipcRenderer.invoke(IPC.saveSettings, input),
  getExtensionStatus: (input) => ipcRenderer.invoke(IPC.getExtensionStatus, input),
  getSkillDetail: (input) => ipcRenderer.invoke(IPC.getSkillDetail, input),
  createSkill: (input) => ipcRenderer.invoke(IPC.createSkill, input),
  updateSkill: (input) => ipcRenderer.invoke(IPC.updateSkill, input),
  importSkill: (input) => ipcRenderer.invoke(IPC.importSkill, input),
  exportSkill: (input) => ipcRenderer.invoke(IPC.exportSkill, input),
  trashSkill: (input) => ipcRenderer.invoke(IPC.trashSkill, input),
  saveExtensionSettings: (input) => ipcRenderer.invoke(IPC.saveExtensionSettings, input),
  probeChromeBrowser: (port) => ipcRenderer.invoke(IPC.probeChromeBrowser, port),
  setBrowserDockLayout: (input) => ipcRenderer.invoke(IPC.browserDockLayout, input),
  browserDockAction: (input) => ipcRenderer.invoke(IPC.browserDockAction, input),
  resolveBrowserSecret: (input) => ipcRenderer.invoke(IPC.browserSecretResolve, input),
  connectMcpOAuth: (input) => ipcRenderer.invoke(IPC.connectMcpOAuth, input),
  disconnectMcpOAuth: (input) => ipcRenderer.invoke(IPC.disconnectMcpOAuth, input),
  reconnectMcp: (input) => ipcRenderer.invoke(IPC.reconnectMcp, input),
  onAgentEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: AgentEvent) => listener(value);
    ipcRenderer.on(IPC.agentEvent, handler);
    return () => ipcRenderer.removeListener(IPC.agentEvent, handler);
  },
  onOrchestrationEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: OrchestrationEvent) => listener(value);
    ipcRenderer.on(IPC.orchestrationEvent, handler);
    return () => ipcRenderer.removeListener(IPC.orchestrationEvent, handler);
  },
  onSessionsChanged: (listener) => {
    const handler = () => listener();
    ipcRenderer.on(IPC.sessionsChanged, handler);
    return () => ipcRenderer.removeListener(IPC.sessionsChanged, handler);
  },
  onExtensionsChanged: (listener) => {
    const handler = () => listener();
    ipcRenderer.on(IPC.extensionsChanged, handler);
    return () => ipcRenderer.removeListener(IPC.extensionsChanged, handler);
  },
  onBrowserSecretRequest: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, request: { requestId: string; name: string; description?: string }) => listener(request);
    ipcRenderer.on(IPC.browserSecretRequest, handler);
    return () => ipcRenderer.removeListener(IPC.browserSecretRequest, handler);
  },
  onBrowserDockState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: BrowserDockState | null) => listener(state);
    ipcRenderer.on(IPC.browserDockState, handler);
    return () => ipcRenderer.removeListener(IPC.browserDockState, handler);
  }
};

contextBridge.exposeInMainWorld('desktopAgent', api);
