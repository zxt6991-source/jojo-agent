import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BrowserRecordingIdSchema, slugifyBrowserRecordingName, type BrowserRecordingDocument } from '@desktop-agent/contracts';
import { BrowserAutomationError } from '../errors';
import type { BrowserRecordingStorePort, BrowserRecordingWriteExpectation } from '../ports/browser-recording-store';
import { finalizeBrowserRecording, hasValidBrowserRecordingHash } from './hash';
import { parseBrowserRecordingYaml, stringifyBrowserRecording } from './serializer';

export class BrowserRecordingStore implements BrowserRecordingStorePort {
  constructor(readonly directory: string) {}

  async list(): Promise<BrowserRecordingDocument[]> {
    let names: string[];
    try { names = (await readdir(this.directory)).filter((name) => name.endsWith('.yaml') || name.endsWith('.yml')); }
    catch { return []; }
    const recordings: BrowserRecordingDocument[] = [];
    const seenIds = new Set<string>();
    for (const name of names.sort()) {
      const fileId = name.replace(/\.ya?ml$/iu, '');
      if (seenIds.has(fileId)) continue;
      try { recordings.push(await this.readRecording(path.join(this.directory, name))); }
      catch { /* invalid recordings are isolated from the registry */ }
      seenIds.add(fileId);
    }
    return recordings;
  }

  async get(id: string): Promise<BrowserRecordingDocument> {
    BrowserRecordingIdSchema.parse(id);
    try { return await this.readRecording(await this.existingRecordingPath(id)); }
    catch (error) {
      if (isMissingFile(error)) throw new BrowserAutomationError('browser_recording_not_found', `Browser recording does not exist: ${id}`);
      throw error;
    }
  }

  async save(document: BrowserRecordingDocument, expectation?: BrowserRecordingWriteExpectation): Promise<BrowserRecordingDocument> {
    BrowserRecordingIdSchema.parse(document.id);
    await mkdir(this.directory, { recursive: true });
    const currentPath = await this.tryExistingRecordingPath(document.id);
    const current = currentPath ? await this.readRecording(currentPath) : undefined;
    if (current) {
      if (!expectation || current.revision !== expectation.expectedRevision || current.contentHash !== expectation.expectedHash) {
        throw new BrowserAutomationError('browser_recording_revision_conflict', `Browser recording ${document.id} changed while it was being updated.`, {
          actualRevision: current.revision,
          expectedRevision: expectation?.expectedRevision
        });
      }
    } else if (expectation) {
      throw new BrowserAutomationError('browser_recording_revision_conflict', `Browser recording ${document.id} no longer exists.`);
    }
    const now = new Date().toISOString();
    const next = finalizeBrowserRecording({
      ...document,
      revision: current ? current.revision + 1 : Math.max(1, document.revision),
      updatedAt: now
    });
    const target = currentPath ?? this.filePath(next.id);
    const temporary = path.join(this.directory, `.${next.id}.${randomUUID()}.tmp`);
    await writeFile(temporary, stringifyBrowserRecording(next), 'utf8');
    try { await rename(temporary, target); }
    catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    return next;
  }

  async delete(id: string): Promise<void> {
    BrowserRecordingIdSchema.parse(id);
    await unlink(await this.existingRecordingPath(id));
  }

  async allocateId(name: string): Promise<string> {
    await mkdir(this.directory, { recursive: true });
    const base = slugifyBrowserRecordingName(name);
    const existing = new Set((await this.list()).map((recording) => recording.id));
    if (!existing.has(base)) return base;
    for (let index = 2; index < 1_000; index += 1) {
      const candidate = `${base.slice(0, Math.max(1, 80 - `-${index}`.length))}-${index}`;
      if (!existing.has(candidate)) return candidate;
    }
    throw new Error('Could not allocate a unique browser recording id.');
  }

  recordingPath(id: string): string {
    BrowserRecordingIdSchema.parse(id);
    return path.join(this.directory, `${id}.yaml`);
  }

  async existingRecordingPath(id: string): Promise<string> {
    BrowserRecordingIdSchema.parse(id);
    const filename = await this.tryExistingRecordingPath(id);
    if (!filename) throw new BrowserAutomationError('browser_recording_not_found', `Browser recording does not exist: ${id}`);
    return filename;
  }

  private filePath(id: string): string { return this.recordingPath(id); }

  private async tryExistingRecordingPath(id: string): Promise<string | undefined> {
    for (const extension of ['yaml', 'yml']) {
      const filename = path.join(this.directory, `${id}.${extension}`);
      try {
        await lstat(filename);
        return filename;
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
    }
    return undefined;
  }

  private async readRecording(filePath: string): Promise<BrowserRecordingDocument> {
    const stats = await lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new BrowserAutomationError('browser_recording_invalid', `Browser recording must be a regular file: ${path.basename(filePath)}.`);
    }
    const text = await readFile(filePath, 'utf8');
    const document = parseBrowserRecordingYaml(text);
    const fileId = path.basename(filePath).replace(/\.ya?ml$/iu, '');
    if (document.id !== fileId) throw new BrowserAutomationError('browser_recording_invalid', `Browser recording id ${document.id} does not match file ${path.basename(filePath)}.`);
    if (!hasValidBrowserRecordingHash(document)) throw new BrowserAutomationError('browser_recording_invalid', `Browser recording hash is invalid: ${document.id}`);
    return document;
  }
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
