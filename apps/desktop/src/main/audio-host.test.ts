import { BrowserWindow, ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { ElectronAudioHost } from './audio-host';
import { AUDIO_HOST_ACK, AUDIO_HOST_COMMAND, AUDIO_HOST_READY } from '../audio-host/ipc';

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  const ipcMain = new EventEmitter();
  class MockWindow extends EventEmitter {
    static windows: MockWindow[] = [];
    static getAllWindows() { return this.windows; }
    destroyed = false;
    options: unknown;
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: '' }, isDestroyed: () => this.destroyed, send: vi.fn(), setWindowOpenHandler: vi.fn(),
      session: Object.assign(new EventEmitter(), {
        setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(),
        webRequest: { onBeforeRequest: vi.fn() }
      })
    });
    constructor(options: unknown) { super(); this.options = options; MockWindow.windows.push(this); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
    async loadFile(file: string) { this.webContents.mainFrame.url = pathToFileURL(file).href; }
    async loadURL(url: string) { this.webContents.mainFrame.url = url; }
  }
  return { BrowserWindow: MockWindow, ipcMain };
});
const hosts: ElectronAudioHost[] = [];
afterEach(() => { hosts.splice(0).forEach((host) => host.close()); (BrowserWindow.getAllWindows() as any[]).splice(0); vi.useRealTimers(); });
function setup() {
  const host = new ElectronAudioHost({ buildDirectory: '/app/.vite/build' }); hosts.push(host);
  const listener = vi.fn(); host.onAck(listener);
  const input = { token: randomUUID(), generation: 3, bytes: new Uint8Array([1, 2]), volume: 0.5 };
  const promise = host.play(input);
  const window = BrowserWindow.getAllWindows().at(-1)! as any;
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  return { host, listener, input, promise, window, event };
}
it('uses a hidden sandbox, independent session, and a minimal preload with no Desktop API', async () => {
  const { window, event, promise, input } = setup();
  expect(window.options).toMatchObject({ show: false, focusable: false, skipTaskbar: true, webPreferences: {
    sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true, backgroundThrottling: false,
    autoplayPolicy: 'no-user-gesture-required', preload: path.join('/app/.vite/build', 'audio-preload.js')
  } });
  expect(window.options.webPreferences.partition).toMatch(/^jojo-audio-host-/u);
  expect(window.options.webPreferences.partition).not.toMatch(/^persist:/u);
  ipcMain.emit(AUDIO_HOST_READY, event); await promise;
  expect(window.webContents.send).toHaveBeenCalledWith(AUDIO_HOST_COMMAND, { type: 'play', ...input });
});
it('requires both its exact sender and main frame for ready and ACK', async () => {
  const { window, event, promise, input, listener } = setup();
  ipcMain.emit(AUDIO_HOST_READY, { ...event, sender: {} });
  ipcMain.emit(AUDIO_HOST_READY, { ...event, senderFrame: { url: window.webContents.mainFrame.url } });
  expect(window.webContents.send).not.toHaveBeenCalled();
  ipcMain.emit(AUDIO_HOST_READY, event); await promise;
  const ack = { type: 'started', token: input.token, generation: input.generation };
  ipcMain.emit(AUDIO_HOST_ACK, { ...event, sender: {} }, ack);
  ipcMain.emit(AUDIO_HOST_ACK, { ...event, senderFrame: {} }, ack);
  ipcMain.emit(AUDIO_HOST_ACK, event, { ...ack, token: randomUUID() });
  ipcMain.emit(AUDIO_HOST_ACK, event, { ...ack, generation: 4 });
  ipcMain.emit(AUDIO_HOST_ACK, event, { ...ack, path: '/private/secret' });
  expect(listener).not.toHaveBeenCalled();
  const savedUrl = event.senderFrame.url; event.senderFrame.url = 'https://untrusted.example';
  ipcMain.emit(AUDIO_HOST_ACK, event, ack); expect(listener).not.toHaveBeenCalled();
  event.senderFrame.url = savedUrl;
  ipcMain.emit(AUDIO_HOST_ACK, event, ack); expect(listener).toHaveBeenCalledWith(ack);
});
it('cancels a pending cold start without sending audio after the host becomes ready', async () => {
  const { host, input, window, event, promise } = setup();
  host.stop(input.token); ipcMain.emit(AUDIO_HOST_READY, event); await promise;
  expect(window.webContents.send.mock.calls.filter((call: unknown[]) => (call[1] as any).type === 'play')).toHaveLength(0);
});
it('denies every permission, download, navigation, and external network request', async () => {
  const { window, event, promise } = setup(); ipcMain.emit(AUDIO_HOST_READY, event); await promise;
  const session = window.webContents.session;
  const permission = session.setPermissionRequestHandler.mock.calls[0][0]; const allowed = vi.fn(); permission({}, 'media', allowed);
  expect(allowed).toHaveBeenCalledWith(false); expect(session.setPermissionCheckHandler.mock.calls[0][0]()).toBe(false);
  const preventDefault = vi.fn(); window.webContents.emit('will-navigate', { preventDefault });
  session.emit('will-download', { preventDefault }); expect(preventDefault).toHaveBeenCalledTimes(2);
  const request = session.webRequest.onBeforeRequest.mock.calls[0][0];
  for (const url of ['https://openspeech.bytedance.com/tts', 'https://evil.example/file.mp3', 'file:///etc/passwd']) {
    const callback = vi.fn(); request({ url }, callback); expect(callback).toHaveBeenCalledWith({ cancel: true });
  }
  const callback = vi.fn(); request({ url: 'blob:file:///private-audio' }, callback); expect(callback).toHaveBeenCalledWith({ cancel: false });
});
it('reports host crashes once and permits a clean new isolated host on explicit retry', async () => {
  const { host, window, event, promise, input, listener } = setup(); ipcMain.emit(AUDIO_HOST_READY, event); await promise;
  window.webContents.emit('render-process-gone');
  expect(listener).toHaveBeenCalledExactlyOnceWith({ type: 'error', token: input.token, generation: input.generation, reason: 'host_crashed' });
  expect(window.isDestroyed()).toBe(true);
  const next = host.play({ ...input, token: randomUUID() });
  const fresh = BrowserWindow.getAllWindows().at(-1)! as any;
  expect(fresh).not.toBe(window);
  ipcMain.emit(AUDIO_HOST_READY, { sender: fresh.webContents, senderFrame: fresh.webContents.mainFrame }); await next;
});
it('times out a missing ready handshake and creates a fresh host for a later retry', async () => {
  vi.useFakeTimers();
  const { host, window, input, promise, listener } = setup();
  await vi.advanceTimersByTimeAsync(10_001); await promise;
  expect(window.isDestroyed()).toBe(true);
  expect(listener).toHaveBeenCalledExactlyOnceWith({ type: 'error', token: input.token, generation: input.generation, reason: 'host_unavailable' });
  const next = host.play({ ...input, token: randomUUID() });
  const fresh = BrowserWindow.getAllWindows().at(-1)! as any;
  expect(fresh).not.toBe(window);
  ipcMain.emit(AUDIO_HOST_READY, { sender: fresh.webContents, senderFrame: fresh.webContents.mainFrame }); await next;
});
