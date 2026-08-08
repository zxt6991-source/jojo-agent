import type { DesktopApi } from '@desktop-agent/contracts';

declare global {
  interface Window { desktopAgent: DesktopApi }
}

export {};
