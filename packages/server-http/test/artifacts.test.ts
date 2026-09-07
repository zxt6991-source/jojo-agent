import { expect, it, vi } from 'vitest';
import { mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createJojoRuntime } from '@desktop-agent/runtime-composition';
import { createJojoAppService } from '@desktop-agent/app-service';
import { createJojoServerCore } from '@desktop-agent/server-core';
import { ScriptedProvider } from '@desktop-agent/agent-runtime/testing';
import { MAX_ARTIFACT_BYTES, type Message } from '@desktop-agent/contracts';
import { produceWorkspaceArtifact } from '@desktop-agent/tools-node';
import { createJojoHttpServer } from '../src';

it('serves only session artifacts with authenticated content, safe headers and bounded reads', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'serve-artifact-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'outside-artifact-'));
  const runtime = await createJojoRuntime({ host: { kind: 'server' }, providers: { resolve: () => new ScriptedProvider([]) }, permissions: { check: async () => ({ decision: 'allow' }) } });
  const core = createJojoServerCore(createJojoAppService(runtime), { workspaceRoots: [root] });
  const server = await createJojoHttpServer(core, { token: 'secret' });
  const headers = { authorization: 'Bearer secret' };
  try {
    for (const id of ['owner', 'other']) {
      const created = await server.app.inject({ method: 'POST', url: '/api/v1/sessions', headers, payload: { id, executionScope: { kind: 'workspace', workingDirectory: root } } });
      expect(created.statusCode, created.body).toBe(201);
    }
    await writeFile(path.join(root, 'report.html'), '<script>alert(1)</script><h1>Report</h1>');
    const artifact = await produceWorkspaceArtifact(root, 'report.html', 'show_artifact');
    const message: Message = { id: 'result', role: 'tool', createdAt: new Date().toISOString(), content: [{ type: 'tool_result', result: { callId: 'call', ok: true, content: 'ready', artifacts: [artifact] } }] };
    vi.spyOn(core, 'transcript').mockImplementation(async (_ctx, sessionId) => ({ items: sessionId === 'owner' ? [{ id: '1', sequence: 1, laneId: 'main', message }] : [] }));
    const url = `/api/v1/sessions/owner/artifacts/${artifact.id}/content`;
    expect((await server.app.inject({ url })).statusCode).toBe(401);
    const list = await server.app.inject({ url: '/api/v1/sessions/owner/artifacts', headers });
    expect(list.json()).toMatchObject([{ id: artifact.id, storage: { type: 'workspace' } }]);
    const content = await server.app.inject({ url, headers });
    expect(content.statusCode).toBe(200);
    expect(content.body).toContain('<script>');
    expect(content.headers['content-security-policy']).toContain('sandbox;');
    expect(content.headers['content-disposition']).toContain('attachment;');
    expect(content.headers.etag).toBeTruthy();
    expect(content.headers['x-content-type-options']).toBe('nosniff');
    expect((await server.app.inject({ url: url.replace('/owner/', '/other/'), headers })).statusCode).toBe(404);
    expect((await server.app.inject({ url: '/api/v1/sessions/owner/artifacts/%2E%2E%2Fsecret/content', headers })).statusCode).toBe(404);
    await truncate(path.join(root, 'report.html'), MAX_ARTIFACT_BYTES + 1);
    expect((await server.app.inject({ url, headers })).statusCode).toBe(403);
    await rm(path.join(root, 'report.html'));
    await writeFile(path.join(outside, 'secret'), 'secret');
    await symlink(path.join(outside, 'secret'), path.join(root, 'report.html'));
    expect((await server.app.inject({ url, headers })).statusCode).toBe(403);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
