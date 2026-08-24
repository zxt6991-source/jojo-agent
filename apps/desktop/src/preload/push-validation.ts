import {
  AgentEventSchema,
  BrowserDockStateSchema,
  BrowserSecretRequestSchema,
  MAX_ORCHESTRATION_EVENT_BYTES,
  OrchestrationEventSchema,
  serializedIpcBytes,
  type AgentEvent,
  type BrowserDockState,
  type OrchestrationEvent
} from '@desktop-agent/contracts';

export function parseAgentPush(raw: unknown): AgentEvent | null {
  const parsed = AgentEventSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function parseOrchestrationPush(raw: unknown): OrchestrationEvent | null {
  if (serializedIpcBytes(raw) > MAX_ORCHESTRATION_EVENT_BYTES) return null;
  const parsed = OrchestrationEventSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function parseBrowserSecretPush(raw: unknown): { requestId: string; name: string; description?: string } | null {
  const parsed = BrowserSecretRequestSchema.safeParse(raw);
  if (!parsed.success) return null;
  return {
    requestId: parsed.data.requestId,
    name: parsed.data.name,
    ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {})
  };
}

export function parseBrowserDockPush(raw: unknown): BrowserDockState | null | undefined {
  const parsed = BrowserDockStateSchema.nullable().safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
