import { Menu, Tray, nativeImage, type BrowserWindow } from 'electron';

function trayImage() {
  const width = 18, height = 18;
  const pixels = Buffer.alloc(width * height * 4);
  const stroke = (x: number, y: number) => (x >= 7 && x <= 10 && y >= 2 && y <= 10)
    || ((x === 4 || x === 13) && y >= 7 && y <= 11)
    || ((y === 12 && (x === 5 || x === 12)) || (y === 13 && x >= 6 && x <= 11))
    || ((x === 8 || x === 9) && y >= 13 && y <= 16) || (y === 16 && x >= 5 && x <= 12);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!stroke(x, y)) continue;
    pixels.set([process.platform === 'darwin' ? 0 : 82, process.platform === 'darwin' ? 0 : 105,
      process.platform === 'darwin' ? 0 : 205, 255], (y * width + x) * 4);
  }
  const image = nativeImage.createFromBitmap(pixels, { width, height, scaleFactor: 1 });
  if (process.platform === 'darwin') image.setTemplateImage(true);
  return image;
}

/** A visible tray and explicit exit action are required before close can hide the main window. */
export class DesktopBackgroundHost {
  private tray: Tray | undefined;
  constructor(private readonly options: { window(): BrowserWindow | null; createWindow(): void; stopSpeech(): void; quit(): void }) {}
  get enabled(): boolean { return Boolean(this.tray && !this.tray.isDestroyed()); }
  configure(enabled: boolean): void {
    if (!enabled) { if (this.enabled) this.show(); this.tray?.destroy(); this.tray = undefined; return; }
    if (this.enabled) return;
    const tray = new Tray(trayImage());
    tray.setToolTip('Jojo · 后台提醒');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开 Jojo', click: () => this.show() },
      { label: '停止当前朗读', click: () => this.options.stopSpeech() },
      { type: 'separator' },
      { label: '退出 Jojo', click: () => this.options.quit() }
    ]));
    tray.on('double-click', () => this.show());
    this.tray = tray;
  }
  show(): void {
    const window = this.options.window();
    if (!window || window.isDestroyed()) { this.options.createWindow(); return; }
    if (window.isMinimized()) window.restore();
    window.show(); window.focus();
  }
  close(): void { this.tray?.destroy(); this.tray = undefined; }
}
