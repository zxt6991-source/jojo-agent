import { expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { LocalAttachmentStore } from '@desktop-agent/attachments';
import { runCli } from '../cli';

it('runs stats and dry-run GC, then applies only with explicit offline mode', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gc-cli-'));
  try {
    const sources = path.join(root, 'sessions');
    await mkdir(sources);
    await writeFile(path.join(sources, 'empty.jsonl'), '');
    const store = new LocalAttachmentStore(path.join(root, 'store'));
    const ref = await store.saveStream({ name: 'file', stream: Readable.from([Buffer.from('abc')]) });
    let output = '';
    const stdout = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } });
    const args = ['--root', store.root, '--source', sources, '--grace-days', '0'];
    await runCli(['node', 'jojo', 'attachments', 'stats', ...args], { stdout, stderr: stdout });
    expect(JSON.parse(output)).toMatchObject({ references: 1, objects: 1, dryRun: true });
    output = '';
    await runCli(['node', 'jojo', 'attachments', 'gc', ...args], { stdout, stderr: stdout });
    expect(await store.exists(ref.attachmentId)).toBe(true);
    await expect(runCli(['node', 'jojo', 'attachments', 'gc', ...args, '--apply'], { stdout, stderr: stdout })).rejects.toThrow(/Stop all/);
    output = '';
    await runCli(['node', 'jojo', 'attachments', 'gc', ...args, '--apply', '--offline'], { stdout, stderr: stdout });
    expect(JSON.parse(output)).toMatchObject({ removedReferences: 1, removedObjects: 1, dryRun: false });
  } finally { await rm(root, { recursive: true, force: true }); }
});
