import { afterEach, expect, it, vi } from 'vitest';
import { link, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type Message } from '@desktop-agent/contracts';
import { artifactRevision, produceWorkspaceArtifact } from '@desktop-agent/tools-node';
import { createArtifactExporter } from './artifact-export';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'artifact-export-')); roots.push(root);
  const source = path.join(root, 'source.txt'); const destination = path.join(root, 'saved.txt');
  await writeFile(source, 'A');
  const artifact = await produceWorkspaceArtifact(root, source, 'write_file');
  const messages: Message[] = [{ id: 'r', role: 'tool', createdAt: new Date().toISOString(), content: [{ type: 'tool_result', result: { callId: 'c', ok: true, content: '', artifacts: [artifact] } }] }];
  const request = { schemaVersion: 2 as const, sessionId: 's', artifactId: artifact.id, expectedRevision: artifactRevision(Buffer.from('A')) };
  const authorize = vi.fn(async () => ({ messages, workingDirectory: root }));
  const select = vi.fn(async () => ({ canceled: false, filePath: destination }));
  const write = vi.fn(async (target: string, bytes: Buffer) => { await writeFile(target, bytes); });
  return { root, source, destination, request, authorize, select, write };
}
it('conflicts before the dialog and never writes or automatically retries', async () => {
  const env = await setup(); await writeFile(env.source, 'B');
  expect(await createArtifactExporter(env)(1, env.request)).toMatchObject({ ok: false, error: { code: 'REVISION_MISMATCH', currentRevision: artifactRevision(Buffer.from('B')) } });
  expect(env.select).not.toHaveBeenCalled(); expect(env.write).not.toHaveBeenCalled();
});
it.each(['edit', 'delete', 'symlink'])('pins checked bytes when the source changes after validation: %s', async (change) => {
  const env = await setup();
  env.select.mockImplementation(async () => {
    if (change === 'edit') await writeFile(env.source, 'B');
    else {
      await rm(env.source);
      if (change === 'symlink') { await writeFile(path.join(env.root, 'other.txt'), 'B'); await symlink(path.join(env.root, 'other.txt'), env.source); }
    }
    return { canceled: false, filePath: env.destination };
  });
  const result = await createArtifactExporter(env)(1, env.request);
  expect(result).toMatchObject({ ok: true, value: { canceled: false, savedRevision: env.request.expectedRevision, size: 1 } });
  expect(await readFile(env.destination, 'utf8')).toBe('A');
  expect(artifactRevision(await readFile(env.destination))).toBe(env.request.expectedRevision);
});
it.each(['source', 'hardlink', 'symlink'])('rejects exporting over the source via %s', async (kind) => {
  const env = await setup();
  if (kind === 'hardlink') await link(env.source, env.destination);
  if (kind === 'symlink') await symlink(env.source, env.destination);
  env.select.mockResolvedValue({ canceled: false, filePath: kind === 'source' ? env.source : env.destination });
  expect(await createArtifactExporter(env)(1, env.request)).toMatchObject({ ok: false, error: { code: 'EXPORT_TARGET_IS_SOURCE' } });
  expect(env.write).not.toHaveBeenCalled();
});
it('handles cancellation and write failure, releasing the export lock in both cases', async () => {
  const env = await setup(); const save = createArtifactExporter(env);
  env.select.mockResolvedValueOnce({ canceled: true, filePath: '' });
  expect(await save(1, env.request)).toEqual({ ok: true, value: { canceled: true } });
  expect(env.write).not.toHaveBeenCalled();
  env.write.mockRejectedValueOnce(new Error('private disk path'));
  expect(await save(1, env.request)).toEqual({ ok: false, error: { code: 'WRITE_FAILED', retryable: true } });
  expect(await save(1, env.request)).toMatchObject({ ok: true });
});
it.each(['evidence', 'binding', 'access'])('rechecks authorization after the dialog: %s revoked', async (kind) => {
  const env = await setup();
  env.select.mockImplementation(async () => {
    if (kind === 'evidence') env.authorize.mockResolvedValue({ messages: [], workingDirectory: env.root });
    if (kind === 'binding') env.authorize.mockResolvedValue({ ...(await env.authorize()), workingDirectory: '/different' });
    if (kind === 'access') env.authorize.mockRejectedValue(new Error('revoked'));
    return { canceled: false, filePath: env.destination };
  });
  expect(await createArtifactExporter(env)(1, env.request)).toMatchObject({ ok: false });
  expect(env.write).not.toHaveBeenCalled();
});
it('rejects concurrent exports from one window without opening another dialog', async () => {
  const env = await setup();
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  env.select.mockImplementation(async () => { await waiting; return { canceled: true, filePath: '' }; });
  const save = createArtifactExporter(env);
  const first = save(1, env.request);
  expect(await save(1, env.request)).toMatchObject({ ok: false, error: { code: 'EXPORT_BUSY' } });
  release(); await first;
  expect(env.select).toHaveBeenCalledTimes(1);
  expect(await save(1, env.request)).toMatchObject({ ok: true });
});
