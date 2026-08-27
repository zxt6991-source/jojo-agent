import type { RuntimeEventEnvelope } from '@desktop-agent/contracts/runtime';

export type RuntimeEventListener = (event: RuntimeEventEnvelope) => void;

