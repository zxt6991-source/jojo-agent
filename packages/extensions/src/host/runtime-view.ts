import type { Disposable, ExtensionRuntimeView } from '@desktop-agent/contracts';

export const EMPTY_EXTENSION_RUNTIME_VIEW: ExtensionRuntimeView = Object.freeze({
  async getSessionInfo() { return undefined; },
  async getLaneInfo() { return undefined; },
  async getRunSnapshot() { return undefined; },
  subscribe(): Disposable { return { dispose() { /* no-op */ } }; }
});
