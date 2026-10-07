import {
  SaveChannelSecretsInputSchema
} from '@desktop-agent/contracts';
import { safeStorage } from 'electron';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseShellSecret } from '../shell-secret-import';

interface Context {
  secretPath: string;
  legacySecretPath: string;
  mcpOAuthSecretPath: string;
  terminalSecretPath: string;
  channelSecretPath: string;
}

export function createDesktopSecrets(ctx: Context) {
  async function readApiKeys(): Promise<Record<string, string>> {
    try {
      const encrypted = await readFile(ctx.secretPath);
      if (!safeStorage.isEncryptionAvailable()) return {};
      const parsed: unknown = JSON.parse(safeStorage.decryptString(encrypted));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return Object.fromEntries(Object.entries(parsed).flatMap(([id, value]) => {
        if (typeof value !== 'string' || !value.trim()) return [];
        return [[id, value.trim()]];
      }));
    } catch {
      try {
        const encrypted = await readFile(ctx.legacySecretPath);
        const key = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(encrypted) : '';
        return key ? { openai: key } : {};
      } catch { return {}; }
    }
  }

  async function saveApiKey(providerId: string, apiKey: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Operating system secure storage is unavailable.');
    const normalizedApiKey = apiKey.trim();
    if (!normalizedApiKey) throw new Error('API Key 不能为空。');
    const keys = await readApiKeys();
    keys[providerId] = normalizedApiKey;
    await mkdir(path.dirname(ctx.secretPath), { recursive: true });
    await writeFile(ctx.secretPath, safeStorage.encryptString(JSON.stringify(keys)), { mode: 0o600 });
  }

  async function readMcpOAuthCredentials(): Promise<Record<string, unknown>> {
    try {
      if (!safeStorage.isEncryptionAvailable()) return {};
      const encrypted = await readFile(ctx.mcpOAuthSecretPath);
      const parsed: unknown = JSON.parse(safeStorage.decryptString(encrypted));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch { return {}; }
  }

  async function saveMcpOAuthCredentials(credentials: Record<string, unknown>): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Operating system secure storage is unavailable.');
    await mkdir(path.dirname(ctx.mcpOAuthSecretPath), { recursive: true });
    await writeFile(ctx.mcpOAuthSecretPath, safeStorage.encryptString(JSON.stringify(credentials)), { mode: 0o600 });
  }

  async function readTerminalSecrets(): Promise<Record<string, string>> {
    try {
      if (!safeStorage.isEncryptionAvailable()) return {};
      const encrypted = await readFile(ctx.terminalSecretPath);
      const parsed: unknown = JSON.parse(safeStorage.decryptString(encrypted));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return Object.fromEntries(Object.entries(parsed).filter(([name, value]) => (
        /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) && typeof value === 'string' && value.length > 0
      ))) as Record<string, string>;
    } catch { return {}; }
  }

  async function saveTerminalSecret(name: string, value: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Operating system secure storage is unavailable.');
    const secrets = await readTerminalSecrets();
    secrets[name] = value;
    await mkdir(path.dirname(ctx.terminalSecretPath), { recursive: true });
    await writeFile(ctx.terminalSecretPath, safeStorage.encryptString(JSON.stringify(secrets)), { mode: 0o600 });
  }

  async function readChannelSecrets(): Promise<Record<string, string>> {
    try {
      if (!safeStorage.isEncryptionAvailable()) return {};
      const encrypted = await readFile(ctx.channelSecretPath);
      const parsed: unknown = JSON.parse(safeStorage.decryptString(encrypted));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return Object.fromEntries(Object.entries(parsed).filter(([name, value]) => (
        /^[A-Z_][A-Z0-9_]*$/u.test(name) && typeof value === 'string' && value.length > 0
      ))) as Record<string, string>;
    } catch { return {}; }
  }

  const channelSecretKeyNames = {
    botToken: 'BOT_TOKEN',
    appSecret: 'APP_SECRET',
    verificationToken: 'VERIFICATION_TOKEN',
    encryptKey: 'ENCRYPT_KEY'
  } as const;

  function channelSecretEnvironmentName(instanceId: string, key: keyof typeof channelSecretKeyNames): string {
    const instanceHash = createHash('sha256').update(instanceId).digest('hex').slice(0, 20).toUpperCase();
    return `JOJO_CHANNEL_${instanceHash}_${channelSecretKeyNames[key]}`;
  }

  async function persistChannelSecrets(input: ReturnType<typeof SaveChannelSecretsInputSchema.parse>): Promise<Record<string, string>> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Operating system secure storage is unavailable.');
    const stored = await readChannelSecrets();
    const references: Record<string, string> = {};
    for (const [rawKey, value] of Object.entries(input.secrets)) {
      if (value === undefined) continue;
      const key = rawKey as keyof typeof channelSecretKeyNames;
      const environmentName = channelSecretEnvironmentName(input.instanceId, key);
      stored[environmentName] = value;
      references[key] = `secret://env/${environmentName}`;
    }
    await mkdir(path.dirname(ctx.channelSecretPath), { recursive: true });
    await writeFile(ctx.channelSecretPath, safeStorage.encryptString(JSON.stringify(stored)), { mode: 0o600 });
    return references;
  }

  async function importTerminalSecretFromShell(name: string): Promise<string> {
    const candidates = ['.zshrc', '.zprofile', '.bashrc', '.bash_profile', '.profile'];
    for (const candidate of candidates) {
      const filePath = path.join(os.homedir(), candidate);
      try {
        const info = await stat(filePath);
        if (!info.isFile() || info.size > 1024 * 1024) continue;
        const value = parseShellSecret(await readFile(filePath, 'utf8'), name);
        if (value) return value;
      } catch { /* Missing or unreadable startup files are skipped. */ }
    }
    throw new Error(`未在受支持的 Shell 配置中找到可安全导入的 ${name}。仅支持静态 export NAME=value，不会执行 Shell。`);
  }

  async function updateMcpOAuthCredentials(serverId: string, credentials: unknown): Promise<void> {
    const all = await readMcpOAuthCredentials();
    if (credentials && typeof credentials === 'object' && Object.keys(credentials).length > 0) all[serverId] = credentials;
    else delete all[serverId];
    await saveMcpOAuthCredentials(all);
  }


  return { readApiKeys, saveApiKey, readMcpOAuthCredentials, readTerminalSecrets, saveTerminalSecret, readChannelSecrets, persistChannelSecrets, importTerminalSecretFromShell, updateMcpOAuthCredentials };
}
