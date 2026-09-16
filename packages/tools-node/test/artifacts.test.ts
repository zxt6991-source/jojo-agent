import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, truncate, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentEventSchema, ArtifactDescriptorSchema, artifactsFromMessages, artifactRenderer, detectArtifacts, MAX_ARTIFACT_BYTES, MessageSchema, resolveArtifactReference, type ArtifactDescriptor, type Message, type ToolContext } from '@desktop-agent/contracts';
import { artifactReadValue, artifactRevision, readSessionArtifactV2, produceWorkspaceArtifact, readSessionArtifact } from '../src/artifact-storage';
import { ShowArtifactTool } from '../src/show-artifact-tool';
import { CreateDocumentTool } from '../src/create-document-tool';
import { EditFileTool, WriteFileTool } from '../src/file-tools';
import { FileSnapshotRegistry } from '../src/file-snapshots';
import { DefaultPermissionGate } from '../src/default-permission-gate';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function workspace() { const root = await mkdtemp(path.join(os.tmpdir(), 'jojo-artifacts-')); roots.push(root); return root; }
function messages(artifacts: ArtifactDescriptor[], callId = 'call'): Message[] {
  return [MessageSchema.parse({ id: callId, role: 'tool', createdAt: new Date().toISOString(), content: [{ type: 'tool_result', result: { callId, ok: true, content: 'done', artifacts } }] })];
}
function context(root: string): ToolContext { return { sessionId: 's', workingDirectory: root, approved: true, signal: new AbortController().signal, onProgress: () => {} }; }

describe('artifact delivery', () => {
  it('preserves structured metadata through schema validation and JSON history replay', async () => {
    const result = await new CreateDocumentTool().execute({ name: '报告.html', content: '<h1>Report</h1>' });
    const history = messages(result.artifacts!);
    expect(artifactsFromMessages(JSON.parse(JSON.stringify(history)))).toEqual(result.artifacts);
    expect(artifactsFromMessages(history.map((message) => ({ ...message, role: 'user' })))).toEqual([]);
    expect(result.artifacts![0]!.storage.type).toBe('conversation');
    const large = { name: 'large.html', content: '中'.repeat(1_000_000) };
    const largeResult = await new CreateDocumentTool().execute(large);
    expect(AgentEventSchema.safeParse({ type: 'tool.started', id: 'large', name: 'create_document', input: large }).success).toBe(true);
    expect(AgentEventSchema.safeParse({ type: 'tool.finished', id: 'large', result: { ...largeResult, callId: 'large' } }).success).toBe(true);

    expect(ArtifactDescriptorSchema.safeParse({ ...result.artifacts![0], name: '../bad.html' }).success).toBe(false);
    expect(ArtifactDescriptorSchema.safeParse({ ...result.artifacts![0], version: 0 }).success).toBe(false);
    expect(ArtifactDescriptorSchema.safeParse({ ...result.artifacts![0], storage: { type: 'conversation', content: 'a'.repeat(2_000_001) } }).success).toBe(false);
    expect(artifactRenderer({ kind: 'html', mimeType: 'application/octet-stream' })).toBe('download-only');
  });
  it('automatically delivers writes and edits with stable identity and replayed version', async () => {
    const root = await workspace(); const snapshots = new FileSnapshotRegistry();
    const writer = new WriteFileTool(snapshots, path.join(root, 'trash'));
    const editor = new EditFileTool(snapshots, path.join(root, 'trash'));
    const first = await writer.execute({ path: 'report.md', content: '# One' }, context(root));
    const second = await editor.execute({ path: 'report.md', oldText: 'One', newText: 'Two' }, context(root));
    const history = [...messages(first.artifacts!, 'a'), ...messages(second.artifacts!, 'b')];
    const latest = artifactsFromMessages(history);
    expect(latest).toHaveLength(1); expect(latest[0]).toMatchObject({ id: first.artifacts![0]!.id, version: 2, kind: 'markdown' });
    expect((await readSessionArtifact(history, root, latest[0]!.id)).bytes.toString()).toBe('# Two');
    const show = await new ShowArtifactTool().execute({ path: 'report.md' }, context(root));
    expect(artifactsFromMessages([...history, ...messages(show.artifacts!, 'c')])[0]!.version).toBe(2);
    const denied = await writer.execute({ path: 'denied.md', content: 'no' }, { ...context(root), approved: false });
    expect(denied.artifacts).toBeUndefined();
  });
  it('requires session evidence and rejects traversal, symlink escapes, directories and oversize files', async () => {
    const root = await workspace(); const outside = await workspace();
    await writeFile(path.join(root, 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await writeFile(path.join(outside, 'secret.txt'), 'secret');
    const artifact = await produceWorkspaceArtifact(root, 'image.svg', 'show_artifact');
    await expect(readSessionArtifact([], root, artifact.id)).rejects.toThrow('not found');
    await expect(produceWorkspaceArtifact(root, path.join(outside, 'secret.txt'), 'show_artifact')).rejects.toThrow('outside');
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
    await expect(produceWorkspaceArtifact(root, 'link.txt', 'show_artifact')).rejects.toThrow('outside');
    await mkdir(path.join(root, 'directory'));
    await expect(produceWorkspaceArtifact(root, 'directory', 'show_artifact')).rejects.toThrow('regular');
    await writeFile(path.join(root, 'large.pdf'), ''); await truncate(path.join(root, 'large.pdf'), MAX_ARTIFACT_BYTES + 1);
    await expect(produceWorkspaceArtifact(root, 'large.pdf', 'show_artifact')).rejects.toThrow('20 MiB');
    await rm(path.join(root, 'image.svg')); await symlink(path.join(outside, 'secret.txt'), path.join(root, 'image.svg'));
    await expect(readSessionArtifact(messages([artifact]), root, artifact.id)).rejects.toThrow('outside');
    expect(await new DefaultPermissionGate().check({ id: 's', name: 'show_artifact', input: { path: 'image.svg' } }, { sessionId: 's', workingDirectory: root })).toMatchObject({ decision: 'deny' });
  });
  it('does not infer failed, running, read or deleted artifacts, and prefers structured results', () => {
    const base = { kind: 'tool', id: 'legacy', name: 'create_document', state: 'ok', input: { name: 'old.html', content: '<h1>old</h1>' } };
    expect(detectArtifacts([base])).toHaveLength(1);
    expect(detectArtifacts([{ ...base, artifacts: [] }])).toEqual([]);
    for (const state of ['running', 'error', 'stopped']) expect(detectArtifacts([{ ...base, state }])).toEqual([]);
    for (const name of ['read_file', 'delete_file']) expect(detectArtifacts([{ ...base, name }])).toEqual([]);
  });
  it('resolves exact paths and only unique basenames', async () => {
    const root = await workspace(); await mkdir(path.join(root, 'sub'));
    await writeFile(path.join(root, 'r.md'), 'a'); await writeFile(path.join(root, 'sub/r.md'), 'b');
    const a = await produceWorkspaceArtifact(root, 'r.md', 'write_file');
    const b = await produceWorkspaceArtifact(root, 'sub/r.md', 'write_file');
    expect(resolveArtifactReference('r.md', [a, b])).toBeUndefined();
    expect(resolveArtifactReference('r.md', [a])).toEqual(a);
    expect(resolveArtifactReference(b.storage.type === 'workspace' ? b.storage.path : '', [a, b])).toEqual(b);
  });
});

describe('V2 content identity', () => {
  it('hashes raw bytes without changing recorded versions; metadata still reads, hashes and authorizes', async () => {
    const root = await workspace(); const file = path.join(root, 'report.md');
    await writeFile(file, '中文\r\nA');
    const artifact = await produceWorkspaceArtifact(root, file, 'write_file');
    const history = messages([artifact]);
    const first = await readSessionArtifactV2(history, root, 's', artifact.id);
    await utimes(file, new Date(0), new Date(0));
    const unchanged = await readSessionArtifactV2(history, root, 's', artifact.id);
    expect(unchanged.info.currentRevision).toBe(first.info.currentRevision);
    expect(artifactReadValue(unchanged, { schemaVersion: 2, sessionId: 's', artifactId: artifact.id, representation: 'content', knownRevision: first.info.currentRevision }).delivery).toBe('not-modified');
    await writeFile(file, 'B');
    const changed = await readSessionArtifactV2(history, root, 's', artifact.id);
    expect(changed.info).toMatchObject({ recordedVersion: 1, recordedState: 'changed-since-recorded', size: 1, currentRevision: artifactRevision(Buffer.from('B')) });
    expect(artifactsFromMessages(history)[0]!.version).toBe(1);
    await expect(readSessionArtifactV2([], root, 'other', artifact.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(readSessionArtifactV2(history, undefined, 's', artifact.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const unknown = await readSessionArtifactV2(messages([{ ...artifact, metadata: { revision: 'invalid' } }]), root, 's', artifact.id);
    expect(unknown.info.recordedState).toBe('recorded-revision-unknown');
    await rm(file);
    await expect(readSessionArtifactV2(history, root, 's', artifact.id)).rejects.toMatchObject({ code: 'CONTENT_MISSING' });
  });
  it('reads historical conversation UTF-8 bytes without workspace access', async () => {
    const result = await new CreateDocumentTool().execute({ name: '中文.html', content: '中文\r\n<h1>A</h1>' });
    const artifact = result.artifacts![0]!;
    const read = await readSessionArtifactV2(messages([artifact]), undefined, 's', artifact.id);
    expect(read.bytes.toString()).toBe('中文\r\n<h1>A</h1>');
    expect(read.info).toMatchObject({ recordedState: 'matches-recorded', recordedRevision: artifactRevision(read.bytes), size: read.bytes.length });
  });
  it('handles empty files and the exact 20 MiB boundary', async () => {
    const root = await workspace(); const file = path.join(root, 'data.pdf');
    await writeFile(file, '');
    const artifact = await produceWorkspaceArtifact(root, file, 'show_artifact');
    const history = messages([artifact]);
    expect((await readSessionArtifactV2(history, root, 's', artifact.id)).info.size).toBe(0);
    const concurrent = Array.from({ length: 4 }, () => readSessionArtifactV2(history, root, 's', artifact.id));
    await expect(readSessionArtifactV2(history, root, 's', artifact.id)).rejects.toMatchObject({ code: 'CONTENT_UNSTABLE' });
    await Promise.all(concurrent);

    await truncate(file, MAX_ARTIFACT_BYTES);
    expect((await readSessionArtifactV2(history, root, 's', artifact.id)).info.size).toBe(MAX_ARTIFACT_BYTES);
    await truncate(file, MAX_ARTIFACT_BYTES + 1);
    await expect(readSessionArtifactV2(history, root, 's', artifact.id)).rejects.toMatchObject({ code: 'CONTENT_TOO_LARGE' });
  });
});
