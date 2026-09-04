import { readRuntimeStatus, isProcessAlive, type RuntimeStatus } from '../bootstrap/instance-lock.js';
import type { EffectiveConfig } from '../config/schema.js';

export type ServerStatus = {
  status: 'running' | 'stopped' | 'stale';
  pid?: number;
  instanceId: string;
  version?: string;
  address?: string;
  startedAt?: string;
  uptimeMs?: number;
  health?: 'ok' | 'unreachable';
  ready?: boolean;
  configFile: string;
  dataDir: string;
};

export async function inspectServer(config: EffectiveConfig): Promise<ServerStatus> {
  const record = await readRuntimeStatus(config.paths.statusFile)
    ?? await readRuntimeStatus(config.paths.lockFile);
  if (!record) return base(config, 'stopped');
  if (!isProcessAlive(record.pid)) return { ...fromRecord(config, record), status: 'stale' };
  const endpoint = record.address;
  if (!endpoint) return { ...fromRecord(config, record), status: 'running', health: 'unreachable' };
  const [health, readiness] = await Promise.all([
    getJson(`${endpoint}/healthz`),
    getJson(`${endpoint}/readyz`)
  ]);
  return {
    ...fromRecord(config, record),
    status: 'running',
    health: health.ok && health.body?.status === 'ok' ? 'ok' : 'unreachable',
    ready: readiness.ok && readiness.body?.status === 'ready'
  };
}

function base(config: EffectiveConfig, status: ServerStatus['status']): ServerStatus {
  return {
    status,
    instanceId: config.runtime.instanceId,
    configFile: config.paths.configFile,
    dataDir: config.paths.dataDir
  };
}

function fromRecord(config: EffectiveConfig, record: RuntimeStatus): Omit<ServerStatus, 'status'> {
  return {
    pid: record.pid,
    instanceId: record.instanceId,
    version: record.version,
    ...(record.address ? { address: record.address } : {}),
    startedAt: record.startedAt,
    uptimeMs: Math.max(0, Date.now() - Date.parse(record.startedAt)),
    configFile: record.configFile || config.paths.configFile,
    dataDir: record.dataDir || config.paths.dataDir
  };
}

async function getJson(url: string): Promise<{ ok: boolean; body?: Record<string, unknown> }> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
    const body = await response.json() as Record<string, unknown>;
    return { ok: response.ok, body };
  } catch {
    return { ok: false };
  }
}

export function formatUptime(milliseconds: number | undefined): string {
  if (milliseconds === undefined) return '-';
  const seconds = Math.floor(milliseconds / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = seconds % 60;
  return [hours, minutes, rest].map((part) => String(part).padStart(2, '0')).join(':');
}
