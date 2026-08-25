import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type BrowserRecordingTrustRecord = {
  contentHash: string;
  approvedAt: string;
};

export interface BrowserRecordingTrustStore {
  isTrusted(filename: string, contentHash: string): Promise<boolean>;
  trust(filename: string, contentHash: string): Promise<void>;
  revoke(filename: string): Promise<void>;
}

export class FileBrowserRecordingTrustStore implements BrowserRecordingTrustStore {
  constructor(readonly filename: string) {}

  private async read(): Promise<Record<string, BrowserRecordingTrustRecord>> {
    try {
      const value = JSON.parse(await readFile(this.filename, 'utf8')) as unknown;
      return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, BrowserRecordingTrustRecord>
        : {};
    } catch {
      return {};
    }
  }

  private async write(data: Record<string, BrowserRecordingTrustRecord>): Promise<void> {
    await mkdir(path.dirname(this.filename), { recursive: true });
    const temporary = `${this.filename}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filename);
  }

  async isTrusted(filename: string, contentHash: string): Promise<boolean> {
    return (await this.read())[path.resolve(filename)]?.contentHash === contentHash;
  }

  async trust(filename: string, contentHash: string): Promise<void> {
    const data = await this.read();
    data[path.resolve(filename)] = { contentHash, approvedAt: new Date().toISOString() };
    await this.write(data);
  }

  async revoke(filename: string): Promise<void> {
    const data = await this.read();
    delete data[path.resolve(filename)];
    await this.write(data);
  }
}
