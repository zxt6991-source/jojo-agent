import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type DesktopApi } from '@desktop-agent/contracts';
import { parseAgentPush, parseBrowserDockPush, parseBrowserSecretPush, parseOrchestrationPush, parseTerminalSecretPush } from './push-validation';

const api: DesktopApi = {
  listSessions: () => ipcRenderer.invoke(IPC.listSessions),
  createSession: (input) => ipcRenderer.invoke(IPC.createSession, input),
  bindSessionProject: (input) => ipcRenderer.invoke(IPC.bindSessionProject, input),
  renameSession: (input) => ipcRenderer.invoke(IPC.renameSession, input),
  deleteSession: (sessionId) => ipcRenderer.invoke(IPC.deleteSession, sessionId),
  loadMessages: (sessionId) => ipcRenderer.invoke(IPC.loadMessages, sessionId),
  loadSessionCompactions: (sessionId) => ipcRenderer.invoke(IPC.loadSessionCompactions, sessionId),
  exportSessionTrajectory: (sessionId) => ipcRenderer.invoke(IPC.exportSessionTrajectory, sessionId),
  getWorkspaceChanges: (sessionId) => ipcRenderer.invoke(IPC.getWorkspaceChanges, sessionId),
  startTurn: (input) => ipcRenderer.invoke(IPC.startTurn, input),
  cancelTurn: (sessionId) => ipcRenderer.invoke(IPC.cancelTurn, sessionId),
  listWorkflowRuns: (sessionId) => ipcRenderer.invoke(IPC.listWorkflowRuns, sessionId),
  cancelWorkflow: (input) => ipcRenderer.invoke(IPC.cancelWorkflow, input),
  resumeWorkflow: (input) => ipcRenderer.invoke(IPC.resumeWorkflow, input),
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
  saveMemorySettings: (input) => ipcRenderer.invoke(IPC.saveMemorySettings, input),
  getMemoryStatus: (input) => ipcRenderer.invoke(IPC.getMemoryStatus, input),
  rebuildMemoryIndex: (input) => ipcRenderer.invoke(IPC.rebuildMemoryIndex, input),
  rebuildSemanticMemoryIndex: (input) => ipcRenderer.invoke(IPC.rebuildSemanticMemoryIndex, input),
  deleteMemoryEntry: (input) => ipcRenderer.invoke(IPC.deleteMemoryEntry, input),
  acceptMemoryCandidate: (input) => ipcRenderer.invoke(IPC.acceptMemoryCandidate, input),
  rejectMemoryCandidate: (input) => ipcRenderer.invoke(IPC.rejectMemoryCandidate, input),
  probeChromeBrowser: (port) => ipcRenderer.invoke(IPC.probeChromeBrowser, port),
  setBrowserDockLayout: (input) => ipcRenderer.invoke(IPC.browserDockLayout, input),
  browserDockAction: (input) => ipcRenderer.invoke(IPC.browserDockAction, input),
  listBrowserRecordings: (input) => ipcRenderer.invoke(IPC.listBrowserRecordings, input),
  trustProjectBrowserRecording: (input) => ipcRenderer.invoke(IPC.trustProjectBrowserRecording, input),
  revokeProjectBrowserRecordingTrust: (input) => ipcRenderer.invoke(IPC.revokeProjectBrowserRecordingTrust, input),
  deleteBrowserRecording: (input) => ipcRenderer.invoke(IPC.deleteBrowserRecording, input),
  getBrowserRecordingStudio: (input) => ipcRenderer.invoke(IPC.getBrowserRecordingStudio, input),
  saveBrowserRecording: (input) => ipcRenderer.invoke(IPC.saveBrowserRecording, input),
  duplicateBrowserRecording: (input) => ipcRenderer.invoke(IPC.duplicateBrowserRecording, input),
  resolveBrowserSecret: (input) => ipcRenderer.invoke(IPC.browserSecretResolve, input),
  resolveTerminalSecret: (input) => ipcRenderer.invoke(IPC.terminalSecretResolve, input),
  connectMcpOAuth: (input) => ipcRenderer.invoke(IPC.connectMcpOAuth, input),
  disconnectMcpOAuth: (input) => ipcRenderer.invoke(IPC.disconnectMcpOAuth, input),
  reconnectMcp: (input) => ipcRenderer.invoke(IPC.reconnectMcp, input),
  trustMcpServer: (input) => ipcRenderer.invoke(IPC.trustMcpServer, input),
  revokeMcpServerTrust: (input) => ipcRenderer.invoke(IPC.revokeMcpServerTrust, input),
  getHookStatus: (input) => ipcRenderer.invoke(IPC.getHookStatus, input),
  reloadHooks: (input) => ipcRenderer.invoke(IPC.reloadHooks, input),
  trustProjectHooks: (input) => ipcRenderer.invoke(IPC.trustProjectHooks, input),
  disableProjectHooks: (input) => ipcRenderer.invoke(IPC.disableProjectHooks, input),
  openHookConfig: (input) => ipcRenderer.invoke(IPC.openHookConfig, input),
  onAgentEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, raw: unknown) => {
      const value = parseAgentPush(raw);
      if (value) listener(value);
    };
    ipcRenderer.on(IPC.agentEvent, handler);
    return () => ipcRenderer.removeListener(IPC.agentEvent, handler);
  },
  onOrchestrationEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, raw: unknown) => {
      const value = parseOrchestrationPush(raw);
      if (value) listener(value);
    };
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
    const handler = (_event: Electron.IpcRendererEvent, raw: unknown) => {
      const request = parseBrowserSecretPush(raw);
      if (request) listener(request);
    };
    ipcRenderer.on(IPC.browserSecretRequest, handler);
    return () => ipcRenderer.removeListener(IPC.browserSecretRequest, handler);
  },
  onTerminalSecretRequest: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, raw: unknown) => {
      const request = parseTerminalSecretPush(raw);
      if (request) listener(request);
    };
    ipcRenderer.on(IPC.terminalSecretRequest, handler);
    return () => ipcRenderer.removeListener(IPC.terminalSecretRequest, handler);
  },
  onBrowserDockState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, raw: unknown) => {
      const state = parseBrowserDockPush(raw);
      if (state !== undefined) listener(state);
    };
    ipcRenderer.on(IPC.browserDockState, handler);
    return () => ipcRenderer.removeListener(IPC.browserDockState, handler);
  }
};

contextBridge.exposeInMainWorld('desktopAgent', api);
