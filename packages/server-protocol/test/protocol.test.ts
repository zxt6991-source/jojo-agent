import { describe, expect, it } from 'vitest';
import {
  ClientHelloSchema,
  JOJO_SERVER_PROTOCOL_VERSION,
  RunSnapshotSchema,
  ServerSessionSnapshotSchema
} from '../src/index.js';

describe('server protocol', () => {
  it('rejects unknown wire fields and unsupported run states', () => {
    expect(ClientHelloSchema.safeParse({
      type: 'hello',
      version: JOJO_SERVER_PROTOCOL_VERSION,
      client: { id: 'client', name: 'test', version: '1' },
      token: 'must-not-be-a-top-level-secret'
    }).success).toBe(false);
    expect(RunSnapshotSchema.safeParse({
      id: 'run', sessionId: 'session', laneId: 'main', status: 'operation_pending', createdAt: new Date().toISOString()
    }).success).toBe(false);
  });

  it('allows a session snapshot with no active lease', () => {
    const createdAt = new Date().toISOString();
    expect(ServerSessionSnapshotSchema.safeParse({
      id: 'session', labels: [], executionScope: { kind: 'none' }, revision: 0,
      runtime: {
        session: { id: 'session', createdAt, executionScope: { kind: 'none' } },
        lanes: [{ id: 'main', sessionId: 'session' }]
      },
      activeRuns: [], transcript: [], pendingApprovals: [], lease: null
    }).success).toBe(true);
  });
});
