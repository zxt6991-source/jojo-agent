import { expect, it, vi } from 'vitest';
import type { FileAttachmentRef, ModelProvider, ModelRequest } from '@desktop-agent/contracts';
import { createJojoRuntime } from '../src';

it('projects attachments on each request and follow-up without persisting execution paths', async () => {
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = { async *stream(request) {
    requests.push(request);
    yield { type: 'text_delta', text: 'done' };
    yield { type: 'response_completed', stopReason: 'stop' };
  } };
  let projectedPath = '/container/first/report.txt';
  const resolve = vi.fn(async () => ({ kind: 'path' as const, path: projectedPath, readonly: true }));
  const runtime = await createJojoRuntime({
    host: { kind: 'server' }, providers: { resolve: () => provider },
    permissions: { check: async () => ({ decision: 'allow' }) },
    attachmentAccess: { resolve }
  });
  try {
    const session = await runtime.openSession({ id: 'attachments', executionScope: { kind: 'workspace', workingDirectory: process.cwd() } });
    const lane = await session.getLane();
    const ref: FileAttachmentRef = { type: 'file', attachmentId: 'att_test', name: 'report.txt', bytes: 3 };
    const first = await (await lane.run({ providerId: 'test', model: 'test', input: { content: [{ type: 'file', attachment: ref }] } })).result;
    expect(first.status).toBe('completed');
    expect(requests[0]?.attachments?.[0]?.access).toMatchObject({ path: projectedPath, readonly: true });
    expect(resolve.mock.calls[0]).toMatchObject([ref, { sessionId: 'attachments', workingDirectory: process.cwd(), executionId: expect.any(String) }]);
    projectedPath = '/container/second/report.txt';
    await (await lane.run({ providerId: 'test', model: 'test', input: { content: [{ type: 'text', text: 'follow up' }] } })).result;
    expect(requests[1]?.attachments?.[0]?.access).toMatchObject({ path: projectedPath });
    const transcript = await lane.readTranscript();
    expect(JSON.stringify(transcript)).toContain('att_test');
    expect(JSON.stringify(transcript)).not.toContain('/container/');
  } finally { await runtime.close(); }
});
