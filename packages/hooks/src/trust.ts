import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type HookTrustRecord = {
  fingerprint?: string;
  approvedAt?: string;
  disabled?: boolean;
  disabledAt?: string;
};
type HookTrustData = Record<string, HookTrustRecord>;

export function hookConfigFingerprint(content: string | Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

export interface HookTrustStore {
  isTrusted(configPath: string, fingerprint: string): Promise<boolean>;
  isDisabled(configPath: string): Promise<boolean>;
  trust(configPath: string, fingerprint: string): Promise<void>;
  disable(configPath: string): Promise<void>;
  revoke(configPath: string): Promise<void>;
}

export class FileHookTrustStore implements HookTrustStore {
  constructor(readonly filename: string) {}

  private async read(): Promise<HookTrustData> {
    try {
      const value = JSON.parse(await readFile(this.filename, 'utf8')) as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
      return value as HookTrustData;
    } catch { return {}; }
  }

  private async write(data: HookTrustData): Promise<void> {
    await mkdir(path.dirname(this.filename), { recursive: true });
    const temporary = `${this.filename}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filename);
  }

  async isTrusted(configPath: string, fingerprint: string): Promise<boolean> {
    const record = (await this.read())[path.resolve(configPath)];
    return Boolean(record && !record.disabled && record.fingerprint === fingerprint);
  }

  async isDisabled(configPath: string): Promise<boolean> {
    return (await this.read())[path.resolve(configPath)]?.disabled === true;
  }

  async trust(configPath: string, fingerprint: string): Promise<void> {
    const data = await this.read();
    data[path.resolve(configPath)] = { fingerprint, approvedAt: new Date().toISOString() };
    await this.write(data);
  }

  async disable(configPath: string): Promise<void> {
    const data = await this.read();
    const key = path.resolve(configPath);
    const current = data[key] ?? {};
    data[key] = { ...current, disabled: true, disabledAt: new Date().toISOString() };
    await this.write(data);
  }

  async revoke(configPath: string): Promise<void> {
    const data = await this.read();
    delete data[path.resolve(configPath)];
    await this.write(data);
  }
}
