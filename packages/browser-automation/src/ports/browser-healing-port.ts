import type { BrowserHealProposal, BrowserHealRequest } from '@desktop-agent/contracts';

export type { BrowserHealProposal, BrowserHealRequest } from '@desktop-agent/contracts';

export interface BrowserHealingPort {
  heal(request: BrowserHealRequest, signal: AbortSignal): Promise<BrowserHealProposal>;
}
