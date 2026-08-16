import { parse, stringify } from 'yaml';
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  migrateBrowserRecording,
  slugifyBrowserRecordingName,
  type BrowserRecordingDocument
} from '@desktop-agent/contracts';

export function stringifyBrowserRecording(document: BrowserRecordingDocument): string {
  return stringify(document, { lineWidth: 0, indent: 2 }).trimEnd() + '\n';
}

export function parseBrowserRecordingYaml(text: string): BrowserRecordingDocument {
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (error) {
    throw new Error(`Invalid browser recording YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  return migrateBrowserRecording(parsed);
}

export class BrowserRecordingStore {
  constructor(private readonly directory: string) {}

  async list(): Promise<BrowserRecordingDocument[]> {
    let names: string[];
    try {
      names = (await readdir(this.directory)).filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'));
    } catch {
      return [];
    }
    const recordings: BrowserRecordingDocument[] = [];
    for (const name of names.sort()) {
      try {
        recordings.push(await this.readFile(path.join(this.directory, name)));
      } catch {
        /* skip unreadable or illegal files */
      }
    }
    return recordings;
  }

  async get(id: string): Promise<BrowserRecordingDocument> {
    return this.readFile(this.filePath(id));
  }

  async save(document: BrowserRecordingDocument): Promise<BrowserRecordingDocument> {
    await mkdir(this.directory, { recursive: true });
    const next = {
      ...document,
      updatedAt: new Date().toISOString()
    };
    await writeFile(this.filePath(next.id), stringifyBrowserRecording(next), 'utf8');
    return next;
  }

  async delete(id: string): Promise<void> {
    await unlink(this.filePath(id));
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

  private filePath(id: string): string {
    return path.join(this.directory, `${id}.yaml`);
  }

  private async readFile(filePath: string): Promise<BrowserRecordingDocument> {
    const text = await readFile(filePath, 'utf8');
    const document = parseBrowserRecordingYaml(text);
    const fileId = path.basename(filePath).replace(/\.ya?ml$/iu, '');
    if (document.id !== fileId) {
      throw new Error(`Browser recording id ${document.id} does not match file ${path.basename(filePath)}.`);
    }
    return document;
  }
}
