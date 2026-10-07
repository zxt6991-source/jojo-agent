import { describe, expect, it } from 'vitest';
import * as application from '@desktop-agent/contracts/application';
import * as protocol from '../src/index.js';

const session = {
  id: 'session', labels: [], executionScope: { kind: 'none' }, revision: 0,
  runtime: {
    session: { id: 'session', createdAt: '2026-09-21T00:00:00.000Z', executionScope: { kind: 'none' } },
    lanes: [{ id: 'main', sessionId: 'session' }]
  },
  activeRuns: [], transcript: [], pendingApprovals: []
};

describe('application contracts and protocol adapters', () => {
  it('shares session, transcript and approval validation by identity', () => {
    expect(protocol.CreateSessionInputSchema).toBe(application.CreateSessionInputSchema);
    expect(protocol.PatchSessionMetadataInputSchema).toBe(application.PatchSessionMetadataInputSchema);
    expect(protocol.TranscriptQuerySchema).toBe(application.TranscriptQuerySchema);
    expect(protocol.TranscriptPageSchema).toBe(application.TranscriptPageSchema);
    expect(protocol.PendingApprovalSnapshotSchema).toBe(application.PendingApprovalSnapshotSchema);
    expect(protocol.ResolveApprovalInputSchema).toBe(application.ResolveApprovalInputSchema);
    expect(protocol.CreateSessionInputSchema.parse({ title: ' New session ' })).toEqual({
      title: 'New session', executionScope: { kind: 'none' }
    });
    expect(protocol.TranscriptQuerySchema.parse({ limit: '25' })).toEqual({ laneId: 'main', limit: 25 });
  });

  it('keeps leases in the transport snapshot', () => {
    expect(application.ApplicationSessionSnapshotSchema.safeParse(session).success).toBe(true);
    expect(application.ApplicationSessionSnapshotSchema.safeParse({ ...session, lease: null }).success).toBe(false);
    expect(protocol.ServerSessionSnapshotSchema.safeParse(session).success).toBe(false);
    expect(protocol.ServerSessionSnapshotSchema.parse({ ...session, lease: null })).toMatchObject({ lease: null });
  });

  it('keeps connection IDs and error request IDs in protocol envelopes', () => {
    const context = { requestId: 'req', principal: { id: 'user', type: 'local', scopes: [] } };
    expect(application.ApplicationContextSchema.safeParse(context).success).toBe(true);
    expect(application.ApplicationContextSchema.safeParse({ ...context, connectionId: 'connection' }).success).toBe(false);
    expect(protocol.RequestContextSchema.safeParse({ ...context, connectionId: 'connection' }).success).toBe(true);
    const error = { code: 'unavailable', message: 'Unavailable', retryable: true };
    expect(application.ApplicationErrorSchema.safeParse(error).success).toBe(true);
    expect(application.ApplicationErrorSchema.safeParse({ ...error, requestId: 'req' }).success).toBe(false);
    expect(protocol.ProtocolErrorSchema.safeParse({ ...error, requestId: 'req' }).success).toBe(true);
    expect(protocol.RunSnapshotSchema.safeParse({
      id: 'run', sessionId: 'session', laneId: 'main', status: 'failed',
      createdAt: '2026-09-21T00:00:00.000Z', error: { ...error, requestId: 'req' }
    }).success).toBe(true);
  });

  it('adds upload receipts without duplicating the application run input', () => {
    const input = {
      input: { content: [{ type: 'text', text: 'hello' }] }, providerId: 'scripted', model: 'test'
    };
    expect(protocol.StartRunInputSchema.parse(input)).toEqual(application.StartRunInputSchema.parse(input));
    const upload = { ...input, attachmentReceipts: { file: '12345678-1234-4234-8234-123456789abc' } };
    expect(protocol.StartRunInputSchema.safeParse(upload).success).toBe(true);
    expect(application.StartRunInputSchema.safeParse(upload).success).toBe(false);
  });
});
