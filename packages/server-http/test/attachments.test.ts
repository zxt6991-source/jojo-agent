import { expect, it } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { LocalAttachmentStore } from '@desktop-agent/attachments';
import { createJojoRuntime } from '@desktop-agent/runtime-composition';
import { createJojoAppService } from '@desktop-agent/app-service';
import { createJojoServerCore } from '@desktop-agent/server-core';
import { ScriptedProvider } from '@desktop-agent/agent-runtime/testing';
import { JojoClient } from '@desktop-agent/client';
import { createJojoHttpServer } from '../src';

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'serve-upload-'));
  const store = new LocalAttachmentStore(root);
  const runtime = await createJojoRuntime({ host: { kind: 'server' }, providers: { resolve: () => new ScriptedProvider([[{ type: 'text_delta', text: 'done' }, { type: 'response_completed', stopReason: 'stop' }]]) }, permissions: { check: async () => ({ decision: 'allow' }) } });
  const core = createJojoServerCore(createJojoAppService(runtime), { attachmentStore: store });
  const server = await createJojoHttpServer(core, { token: 'secret', port: 0 });
  const ctx = { requestId: 'test', principal: { id: 'token', type: 'token' as const, scopes: ['admin'] } };
  const headers = { authorization: 'Bearer secret' };
  for (const id of ['session', 'other']) await server.app.inject({ method: 'POST', url: '/api/v1/sessions', headers, payload: { id, executionScope: { kind: 'none' } } });
  return { root, store, core, server, ctx, headers, async close() { await server.close(); await rm(root, { recursive: true, force: true }); } };
}

it('streams uploads larger than JSON body limit via client and returns a usable server-owned receipt', async () => {
  const test = await setup();
  try {
    const client = new JojoClient({ baseUrl: await test.server.listen(), token: 'secret' });
    const data = new Blob([new Uint8Array(2 * 1024 * 1024)]);
    const result = await client.uploadAttachment('session', data, '固件.bin');
    expect(result.attachment).toMatchObject({ name: '固件.bin', bytes: data.size });
    expect(await test.store.verify(result.attachment.attachmentId)).toMatchObject({ verified: true });
    await (await client.getSession('session')).attach('control');
    await (await client.getSession('other')).attach('control');
    const runHeaders = { ...test.headers, 'x-jojo-connection-id': client.connectionId! };
    const input = { providerId: 'test', model: 'test', input: { content: [{ type: 'file' as const, attachment: { ...result.attachment, name: 'forged', preview: { type: 'text' as const, extractor: 'fake', text: 'forged preview', truncated: false } } }] }, attachmentReceipts: { [result.attachment.attachmentId]: result.receipt } };
    const accepted = await test.server.app.inject({ method: 'POST', url: '/api/v1/sessions/session/runs', headers: runHeaders, payload: input });
    expect(accepted.statusCode).toBe(202);
    const mismatch = await test.server.app.inject({ method: 'POST', url: '/api/v1/sessions/other/runs', headers: runHeaders, payload: input });
    expect(mismatch.statusCode).toBe(400);
    const forged = await test.server.app.inject({ method: 'POST', url: '/api/v1/sessions/other/runs', headers: runHeaders, payload: { ...input, attachmentReceipts: {} } });
    expect(forged.statusCode).toBe(400);
    const snapshot = await client.getSession('session');
    const transcript = await snapshot.transcript();
    expect(JSON.stringify(transcript)).toContain('固件.bin');
    expect(JSON.stringify(transcript)).not.toContain('forged');
    await expect(client.command({ id: 'forged-ws', type: 'run.start', sessionId: 'other', input: { ...input, laneId: 'main', attachmentReceipts: {} } })).rejects.toThrow(/receipt/);
    await client.close();
  } finally { await test.close(); }
});

it('authenticates upload and rejects invalid files without publishing refs', async () => {
  const test = await setup();
  try {
    const unauthorized = await test.server.app.inject({ method: 'POST', url: '/api/v1/sessions/session/attachments?name=a.txt', headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('abc') });
    expect(unauthorized.statusCode).toBe(401);
    const wrongType = await test.server.app.inject({ method: 'POST', url: '/api/v1/sessions/session/attachments?name=a.txt', headers: test.headers, payload: { data: 'abc' } });
    expect(wrongType.statusCode).toBe(400);
    const missing = await test.server.app.inject({ method: 'POST', url: '/api/v1/sessions/missing/attachments?name=a.txt', headers: { ...test.headers, 'content-type': 'application/octet-stream' }, payload: Buffer.from('abc') });
    expect(missing.statusCode).not.toBe(201);
    expect(await readdir(test.root)).toEqual([]);
  } finally { await test.close(); }
});

it('disconnect cancels a chunked upload and cleans staging', async () => {
  const test = await setup();
  try {
    const address = await test.server.listen();
    const request = httpRequest(`${address}/api/v1/sessions/session/attachments?name=cancel.bin`, { method: 'POST', headers: { ...test.headers, 'content-type': 'application/octet-stream' } });
    request.on('error', () => {});
    request.write(Buffer.alloc(65536));
    for (let i = 0; i < 100; i++) {
      if ((await readdir(path.join(test.root, 'refs')).catch(() => [])).length) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    request.destroy();
    for (let i = 0; i < 100; i++) {
      if (!(await readdir(path.join(test.root, 'refs')).catch(() => [])).length) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(await readdir(path.join(test.root, 'refs'))).toEqual([]);
  } finally { await test.close(); }
});
