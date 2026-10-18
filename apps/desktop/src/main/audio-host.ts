import { BrowserWindow, ipcMain, type IpcMainEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AUDIO_HOST_ACK, AUDIO_HOST_COMMAND, AUDIO_HOST_READY, isAudioHostAck, type AudioHostAck, type AudioHostPlayInput } from '../audio-host/ipc';
import type { AudioHostPort } from './playback-broker';

declare const AUDIO_HOST_VITE_DEV_SERVER_URL: string | undefined;
declare const AUDIO_HOST_VITE_NAME: string;

export interface ElectronAudioHostOptions {
  buildDirectory: string;
  /** Overrides are Main-owned build/test URLs, never renderer input. */
  devServerUrl?: string;
  rendererName?: string;
  readyTimeoutMs?: number;
}
/** An independent sandbox and isolated ephemeral session, with exactly two
 * incoming IPC routes. No Desktop API, permissions, downloads, or navigation. */
export class ElectronAudioHost implements AudioHostPort {
  private window: BrowserWindow | undefined;
  private ready: Promise<void> | undefined;
  private expectedUrl: string | undefined;
  private active: { token: string; generation: number } | undefined;
  private readonly listeners = new Set<(ack: AudioHostAck) => void>();
  private closed = false;
  private readonly receiveAck = (event: IpcMainEvent, input: unknown) => {
    if (!this.trusted(event) || !isAudioHostAck(input) || input.token !== this.active?.token || input.generation !== this.active.generation) return;
    if (input.type !== 'started') this.active = undefined;
    this.emit(input);
  };
  constructor(private readonly options: ElectronAudioHostOptions) { ipcMain.on(AUDIO_HOST_ACK, this.receiveAck); }
  onAck(listener: (ack: AudioHostAck) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async play(input: AudioHostPlayInput): Promise<void> {
    if (this.closed) throw new Error('host_unavailable');
    // Set before awaiting the ready handshake, so stop also cancels cold starts.
    this.active = { token: input.token, generation: input.generation };
    try { await this.ensureWindow(); }
    catch {
      if (this.active?.token === input.token) {
        this.active = undefined;
        this.emit({ type: 'error', token: input.token, generation: input.generation, reason: 'host_unavailable' });
      }
      return;
    }
    if (this.closed || this.active?.token !== input.token || !this.window || this.window.isDestroyed()) return;
    this.window.webContents.send(AUDIO_HOST_COMMAND, { type: 'play', ...input });
  }
  stop(token: string): void {
    if (this.active?.token !== token) return;
    this.active = undefined;
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send(AUDIO_HOST_COMMAND, { type: 'stop', token });
  }
  close(): void {
    this.closed = true; this.active = undefined;
    ipcMain.removeListener(AUDIO_HOST_ACK, this.receiveAck);
    this.listeners.clear();
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = undefined; this.ready = undefined; this.expectedUrl = undefined;
  }
  private emit(ack: AudioHostAck): void { for (const listener of this.listeners) listener(ack); }
  private trusted(event: IpcMainEvent): boolean {
    const contents = this.window?.webContents;
    return Boolean(contents && !contents.isDestroyed() && event.sender === contents && event.senderFrame === contents.mainFrame &&
      event.senderFrame.url === this.expectedUrl);
  }
  private ensureWindow(): Promise<void> {
    if (this.ready && this.window && !this.window.isDestroyed()) return this.ready;
    const devUrl = this.options.devServerUrl ?? (typeof AUDIO_HOST_VITE_DEV_SERVER_URL === 'undefined' ? undefined : AUDIO_HOST_VITE_DEV_SERVER_URL);
    const name = this.options.rendererName ?? (typeof AUDIO_HOST_VITE_NAME === 'undefined' ? 'audio_host' : AUDIO_HOST_VITE_NAME);
    const html = path.join(this.options.buildDirectory, `../renderer/${name}/audio-host.html`);
    const expectedUrl = devUrl ? new URL('audio-host.html', devUrl).href : pathToFileURL(html).href;
    this.expectedUrl = expectedUrl;
    const window = new BrowserWindow({
      show: false, width: 1, height: 1, focusable: false, skipTaskbar: true,
      webPreferences: {
        preload: path.join(this.options.buildDirectory, 'audio-preload.js'),
        sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true,
        backgroundThrottling: false, partition: `jojo-audio-host-${randomUUID()}`,
        autoplayPolicy: 'no-user-gesture-required'
      }
    });
    this.window = window;
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.on('will-redirect', (event) => event.preventDefault());
    window.webContents.on('will-attach-webview', (event) => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.webContents.session.on('will-download', (event) => event.preventDefault());
    // CSP limits the renderer too; this independently closes its network surface.
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url);
      const development = devUrl ? new URL(devUrl) : undefined;
      const allowed = url.protocol === 'blob:' || (url.protocol === 'file:' && url.href.startsWith(pathToFileURL(path.dirname(html) + path.sep).href)) ||
        Boolean(development && url.hostname === development.hostname && url.port === development.port && ['http:', 'ws:'].includes(url.protocol));
      callback({ cancel: !allowed });
    });
    window.webContents.on('render-process-gone', () => this.hostGone(window));
    window.on('closed', () => this.hostGone(window));
    this.ready = new Promise<void>((resolve, reject) => {
      let finished = false;
      const finish = (success: boolean) => {
        if (finished) return;
        finished = true; clearTimeout(timeout);
        ipcMain.removeListener(AUDIO_HOST_READY, receiveReady);
        window.removeListener('closed', failed);
        window.webContents.removeListener('did-fail-load', failed);
        if (success) resolve(); else reject(new Error('host_unavailable'));
      };
      const receiveReady = (event: IpcMainEvent) => {
        if (this.trusted(event) && event.senderFrame?.url === expectedUrl) finish(true);
      };
      const failed = () => finish(false);
      const timeout = setTimeout(failed, this.options.readyTimeoutMs ?? 10_000);
      ipcMain.on(AUDIO_HOST_READY, receiveReady);
      window.once('closed', failed); window.webContents.once('did-fail-load', failed);
      void (devUrl ? window.loadURL(expectedUrl) : window.loadFile(html)).catch(failed);
    }).catch((error: unknown) => {
      if (this.window === window) {
        this.window = undefined; this.ready = undefined; this.expectedUrl = undefined;
        if (!window.isDestroyed()) window.destroy();
      }
      throw error;
    });
    return this.ready;
  }
  private hostGone(window: BrowserWindow): void {
    if (window !== this.window) return;
    this.window = undefined; this.ready = undefined; this.expectedUrl = undefined;
    const active = this.active; this.active = undefined;
    if (active && !this.closed) this.emit({ type: 'error', ...active, reason: 'host_crashed' });
    if (!window.isDestroyed()) window.destroy();
  }
}
