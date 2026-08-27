import { describe, expect, it } from 'vitest';
import {
  ExecutionScopeSchema,
  RunResultSchema,
  RuntimeEventEnvelopeSchema
} from '../src/runtime.js';

describe('runtime wire contract', () => {
  it('accepts serializable execution scopes and rejects non-JSON custom data', () => {
    expect(ExecutionScopeSchema.parse({ kind: 'workspace', workingDirectory: '/workspace' })).toEqual({
      kind: 'workspace', workingDirectory: '/workspace'
    });
    expect(ExecutionScopeSchema.safeParse({ kind: 'custom', type: 'tenant', data: { id: 1n } }).success).toBe(false);
  });

  it('validates stable lifecycle envelopes and run results', () => {
    expect(RuntimeEventEnvelopeSchema.safeParse({
      schemaVersion: 1,
      eventId: 'event-1',
      sequence: 1,
      timestamp: '2026-08-26T00:00:00.000Z',
      sessionId: 'session-1',
      laneId: 'main',
      runId: 'run-1',
      event: { type: 'run.started' }
    }).success).toBe(true);
    expect(RunResultSchema.safeParse({
      runId: 'run-1',
      sessionId: 'session-1',
      laneId: 'main',
      status: 'completed',
      stopReason: 'stop',
      messages: []
    }).success).toBe(true);
  });
});
