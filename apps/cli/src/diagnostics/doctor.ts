import type { EffectiveConfig } from '../config/schema.js';
import { runPreflight, type CheckResult } from '../bootstrap/preflight.js';
import { inspectServer } from './process-info.js';
import { createServiceManager } from '../service/service-manager.js';

export type DoctorCheck = CheckResult & { detail?: string };

export async function diagnose(config: EffectiveConfig): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [
    { name: 'node', status: 'ok', message: `Node ${process.versions.node}` },
    { name: 'jojo', status: 'ok', message: 'Jojo 0.1.0' }
  ];
  try {
    checks.push(...await runPreflight(config));
  } catch (error) {
    checks.push({ name: 'preflight', status: 'warning', message: error instanceof Error ? error.message : String(error) });
  }
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const database = new DatabaseSync(':memory:');
    database.exec('SELECT 1');
    database.close();
    checks.push({ name: 'sqlite', status: 'ok', message: 'SQLite available' });
  } catch (error) {
    checks.push({ name: 'sqlite', status: 'warning', message: error instanceof Error ? error.message : String(error) });
  }
  const server = await inspectServer(config);
  checks.push({
    name: 'server',
    status: server.status === 'running' ? 'ok' : 'warning',
    message: server.status === 'running' ? `Server running (health: ${server.health ?? 'unknown'})` : `Server ${server.status}`
  });
  try {
    const service = await createServiceManager().status();
    checks.push({
      name: 'service',
      status: service.installed ? 'ok' : 'warning',
      message: service.installed ? `OS service installed (${service.running ? 'running' : 'stopped'})` : 'OS service not installed'
    });
  } catch (error) {
    checks.push({ name: 'service', status: 'warning', message: error instanceof Error ? error.message : String(error) });
  }
  return checks;
}
