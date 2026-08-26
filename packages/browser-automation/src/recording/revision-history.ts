import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserRecordingDocument } from '@desktop-agent/contracts';
import { parseBrowserRecordingYaml, stringifyBrowserRecording } from './serializer';

export type BrowserRecordingRevisionSummary = {
  revision: number;
  contentHash: string;
  updatedAt: string;
  current: boolean;
};

export class BrowserRecordingRevisionHistoryStore {
  constructor(private readonly directory: string) {}

  async archive(recording: BrowserRecordingDocument): Promise<void> {
    const directory = this.recordingDirectory(recording.id);
    await mkdir(directory, { recursive: true });
    const hash = recording.contentHash.replace(/^sha256:/u, '').slice(0, 16);
    await writeFile(path.join(directory, `r${recording.revision}-${hash}.yaml`), stringifyBrowserRecording(recording), {
      encoding: 'utf8', flag: 'wx', mode: 0o600
    }).catch((error) => {
      if (!isCode(error, 'EEXIST')) throw error;
    });
  }

  async list(current: BrowserRecordingDocument): Promise<BrowserRecordingRevisionSummary[]> {
    const documents: BrowserRecordingDocument[] = [];
    try {
      const directory = this.recordingDirectory(current.id);
      for (const name of await readdir(directory)) {
        if (!/^r[1-9][0-9]*-[a-f0-9]+\.yaml$/u.test(name)) continue;
        const document = parseBrowserRecordingYaml(await readFile(path.join(directory, name), 'utf8'));
        if (document.id === current.id) documents.push(document);
      }
    } catch (error) {
      if (!isCode(error, 'ENOENT')) throw error;
    }
    const unique = new Map(documents.map((document) => [`${document.revision}:${document.contentHash}`, document]));
    unique.set(`${current.revision}:${current.contentHash}`, current);
    return [...unique.values()].sort((left, right) => right.revision - left.revision).map((document) => ({
      revision: document.revision,
      contentHash: document.contentHash,
      updatedAt: document.updatedAt,
      current: document.revision === current.revision && document.contentHash === current.contentHash
    }));
  }

  private recordingDirectory(id: string): string { return path.join(this.directory, id); }
}

function isCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}
