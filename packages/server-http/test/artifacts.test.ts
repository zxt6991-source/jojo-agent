import { describeTestProvider } from '@desktop-agent/agent-runtime/testing';
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
  const runtime = await createJojoRuntime({ host: { kind: 'server' }, providers: { describe: describeTestProvider, resolve: () => new ScriptedProvider([]) }, permissions: { check: async () => ({ decision: 'allow' }) } });
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
    const v2 = url.replace('/api/v1/', '/api/v2/');
    const metadataUrl = v2.replace('/content', '/metadata');
    const unauthenticated = await server.app.inject({ url: v2 });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json()).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
    const metadata = await server.app.inject({ url: metadataUrl, headers });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.headers.etag).toBeUndefined();
    expect(metadata.json()).toMatchObject({ schemaVersion: 2, recordedVersion: 1, recordedState: 'matches-recorded', etag: content.headers.etag });
    const conditionalHeaders = { ...headers, 'if-match': String(metadata.json().etag) };
    const matched = await server.app.inject({ url: v2, headers: conditionalHeaders });
    expect(matched.statusCode).toBe(200);
    expect(matched.body).toBe(content.body);
    expect(matched.headers['content-length']).toBe(String(Buffer.byteLength(content.body)));
    expect(matched.headers.etag).toBe(metadata.json().etag);
    for (const etag of ['*', 'abc', `W/${metadata.json().etag}`, `${metadata.json().etag}, ${metadata.json().etag}`]) {
      const invalid = await server.app.inject({ url: v2, headers: { ...headers, 'if-match': etag } });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    }
    expect((await server.app.inject({ url: v2.replace('/owner/', '/other/'), headers: conditionalHeaders })).statusCode).toBe(404);
    await writeFile(path.join(root, 'report.html'), '<h1>Changed</h1>');
    const conflict = await server.app.inject({ url: v2, headers: conditionalHeaders });
    expect(conflict.statusCode).toBe(412);
    expect(conflict.json()).toMatchObject({ ok: false, error: { code: 'REVISION_MISMATCH' } });
    expect(conflict.headers['content-disposition']).toBeUndefined();
    expect(conflict.headers.etag).toBeUndefined();
    expect((await server.app.inject({ url: metadataUrl, headers })).json()).toMatchObject({ recordedVersion: 1, recordedState: 'changed-since-recorded' });
    await truncate(path.join(root, 'report.html'), MAX_ARTIFACT_BYTES + 1);
    expect((await server.app.inject({ url, headers })).statusCode).toBe(403);
    expect((await server.app.inject({ url: metadataUrl, headers })).statusCode).toBe(413);
    await rm(path.join(root, 'report.html'));
    expect((await server.app.inject({ url: metadataUrl, headers })).statusCode).toBe(410);
    await writeFile(path.join(outside, 'secret'), 'secret');
    await symlink(path.join(outside, 'secret'), path.join(root, 'report.html'));
    expect((await server.app.inject({ url, headers })).statusCode).toBe(403);
    expect((await server.app.inject({ url: metadataUrl, headers })).statusCode).toBe(403);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

it.each(['none', 'custom'] as const)('allows only historical conversation content in %s scope, including PDF metadata', async (kind) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'artifact-scope-'));
  const runtime = await createJojoRuntime({ host: { kind: 'server' }, providers: { describe: describeTestProvider, resolve: () => new ScriptedProvider([]) }, permissions: { check: async () => ({ decision: 'allow' }) } });
  const core = createJojoServerCore(createJojoAppService(runtime), { workspaceRoots: [root] });
  const server = await createJojoHttpServer(core, { token: 'secret' });
  const headers = { authorization: 'Bearer secret' };
  try {
    const create = await server.app.inject({ method: 'POST', url: '/api/v1/sessions', headers, payload: { id: 's', executionScope: kind === 'none' ? { kind } : { kind, type: 'test', data: {} } } });
    expect(create.statusCode, create.body).toBe(201);
    await writeFile(path.join(root, 'a.pdf'), '%PDF-test');
    const artifact = await produceWorkspaceArtifact(root, 'a.pdf', 'show_artifact');
    const conversation = { ...artifact, id: 'conversation', storage: { type: 'conversation' as const, content: '中文\r\n%PDF-test' } };
    const message: Message = { id: 'r', role: 'tool', createdAt: new Date().toISOString(), content: [{ type: 'tool_result', result: { callId: 'c', ok: true, content: '', artifacts: [artifact, conversation] } }] };
    vi.spyOn(core, 'transcript').mockResolvedValue({ items: [{ id: '1', sequence: 1, laneId: 'main', message }] });
    const base = '/api/v2/sessions/s/artifacts';
    expect((await server.app.inject({ url: `${base}/${artifact.id}/metadata`, headers })).statusCode).toBe(403);
    const meta = await server.app.inject({ url: `${base}/conversation/metadata`, headers });
    expect(meta.statusCode).toBe(200);
    expect(meta.json()).toMatchObject({ storageType: 'conversation', mimeType: 'application/pdf', recordedState: 'matches-recorded', size: Buffer.byteLength(conversation.storage.content) });
    const download = await server.app.inject({ url: `${base}/conversation/content`, headers: { ...headers, 'if-match': meta.json().etag } });
    expect(download.statusCode).toBe(200); expect(download.body).toBe(conversation.storage.content);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});
