import { createHash } from 'node:crypto';
import { access, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { McpServerCapability, McpServerConfig } from '@desktop-agent/contracts';

type McpSecurityIdentity = {
  transport: McpServerConfig['transport'];
  endpoint: string;
  args?: string[];
  cwd?: string;
  environmentKeys?: string[];
  headerKeys?: string[];
  secretReferences?: string[];
  workspaceAccess: 'none' | 'read' | 'write';
  network: 'none' | 'outbound' | 'private';
  sandboxMode: 'strict' | 'fallback';
  allowInstructions: boolean;
  trustedReadTools: string[];
};

export type McpFingerprintResult = {
  fingerprint: string;
  identity: McpSecurityIdentity;
  capabilities: McpServerCapability[];
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

async function executablePath(command: string): Promise<string> {
  if (path.isAbsolute(command) || command.includes(path.sep)) {
    try { return await realpath(path.resolve(command)); } catch { return path.resolve(command); }
  }
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, command);
    try { await access(candidate); return await realpath(candidate); } catch { /* Continue searching. */ }
  }
  return command;
}

function normalizedSecurity(config: McpServerConfig) {
  return {
    workspaceAccess: config.security?.workspaceAccess ?? 'none',
    network: config.security?.network ?? 'none',
    sandboxMode: config.security?.sandboxMode ?? 'fallback',
    allowInstructions: config.security?.allowInstructions ?? false,
    trustedReadTools: [...(config.security?.trustedReadTools ?? [])].sort()
  } as const;
}

export async function mcpServerFingerprint(config: McpServerConfig): Promise<McpFingerprintResult> {
  const security = normalizedSecurity(config);
  const identity: McpSecurityIdentity = config.transport === 'stdio'
    ? {
        transport: 'stdio', endpoint: await executablePath(config.command), args: [...config.args],
        cwd: security.workspaceAccess === 'none' ? 'isolated-temp' : path.resolve(config.cwd ?? process.cwd()),
        environmentKeys: Object.keys(config.env ?? {}).sort(), secretReferences: secretReferences(config.env), ...security
      }
    : {
        transport: 'streamable_http', endpoint: new URL(config.url).toString(),
        headerKeys: Object.keys(config.headers ?? {}).map((key) => key.toLowerCase()).sort(), secretReferences: secretReferences(config.headers), ...security
      };
  const capabilities: McpServerCapability[] = [];
  if (security.workspaceAccess !== 'none') capabilities.push('workspace:read');
  if (security.workspaceAccess === 'write') capabilities.push('workspace:write');
  if (security.network !== 'none') capabilities.push('network:outbound');
  if (security.network === 'private') capabilities.push('network:private');
  if (config.transport === 'stdio') capabilities.push('process:spawn');
  if (Object.keys(config.transport === 'stdio' ? config.env ?? {} : config.headers ?? {}).length > 0) capabilities.push('credential:secret');
  if (security.allowInstructions) capabilities.push('instructions:contribute');
  return {
    fingerprint: createHash('sha256').update(canonical(identity)).digest('hex'),
    identity,
    capabilities
  };
}

function secretReferences(values: Record<string, string | { value: string } | { secretRef: { provider: string; key: string } }> | undefined): string[] {
  return Object.entries(values ?? {}).flatMap(([name, value]) => typeof value === 'object' && 'secretRef' in value
    ? [`${name.toLowerCase()}:${value.secretRef.provider}:${value.secretRef.key}`]
    : []).sort();
}
