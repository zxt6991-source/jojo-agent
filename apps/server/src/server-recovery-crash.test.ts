import { DatabaseSync } from 'node:sqlite';
import type { SessionEntry } from '@desktop-agent/agent-runtime/spi';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const fixture = path.resolve('apps/server/test-fixtures/run-recovery-host.mjs');

type Report = {
  checkpoint?: string;
  recoveredProviderCalls: number;
  approvalReplayError?: string;
  entries: SessionEntry[];
  old: Array<{ id: string; status: string; error?: { code: string } }>;
  ids: string[];
  effects: number;
  result: { status: string };
  integrity: { integrity_check: string };
};
function child(directory: string, mode: string, point = '') {
  const process = spawn(globalThis.process.execPath, [fixture, directory, mode, point], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  process.stderr!.on('data', chunk => { stderr += String(chunk); });
  const exit = new Promise<void>(resolve => process.once('exit', () => resolve()));
  const message = new Promise<Report>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Checkpoint timed out: ${mode}/${point}\n${stderr}`)), 20000);
    process.once('message', message => { clearTimeout(timer); resolve(message as Report); });
    process.once('exit', code => { clearTimeout(timer); reject(new Error(`Host exited (${code}) before report: ${stderr}`)); });
    process.once('error', reject);
  });
  return { process, message, exit };
}
async function kill(process: ChildProcess) {
  if (process.exitCode !== null || process.signalCode !== null) return;
  const exited = new Promise<void>(resolve => process.once('exit', () => resolve()));
  process.kill('SIGKILL'); await exited;
}

describe('real SQLite crash recovery', () => {
  it.each(['accepted', 'operation_started', 'model_pending', 'assistant_entry', 'approval', 'effect_pending', 'effect_fsynced', 'result_entry'])(
    'recovers after SIGKILL at %s without replay and permits same-session runs', async point => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-crash-'));
      const children: ChildProcess[] = [];
      try {
        const seed = child(directory, 'seed', point); children.push(seed.process);
        expect((await seed.message).checkpoint).toBe(point);
        await kill(seed.process);
        const first = child(directory, 'recover'); children.push(first.process);
        const report = await first.message; await first.exit;
        expect(report.recoveredProviderCalls).toBe(0);
        expect(report.old.find(run => run.id === 'old')).toMatchObject({ status: 'interrupted', error: { code: point === 'accepted' ? 'run_start_not_committed' : 'runtime_interrupted' } });
        expect(report.result.status).toBe('completed');
        const blocks = report.entries.flatMap(entry => entry.type === 'message' ? entry.message.content : []);
        const calls = blocks.flatMap(block => block.type === 'tool_call' ? [block.call.id] : []);
        const results = blocks.flatMap(block => block.type === 'tool_result' ? [block.result] : []);
        expect(results.map(result => result.callId)).toEqual(calls);
        if (point === 'approval') expect(report.approvalReplayError).toContain('approval_interrupted');
        if (['effect_pending', 'effect_fsynced'].includes(point)) expect(results[0]?.code).toBe('interrupted_uncertain_effect');
        if (point === 'result_entry') expect(results[0]).toMatchObject({ ok: true, content: 'effect persisted' });
        expect(report.integrity.integrity_check).toBe('ok');
        expect(report.effects).toBe(['effect_fsynced', 'result_entry'].includes(point) ? 1 : 0);
        const second = child(directory, 'recover'); children.push(second.process);
        const repeated = await second.message; await second.exit;
        expect(repeated.ids).toEqual(report.ids);
        expect(repeated.effects).toBe(report.effects);
        expect(repeated.result.status).toBe('completed');
      } finally {
        await Promise.all(children.map(kill));
        await rm(directory, { recursive: true, force: true });
      }
    }, 60000
  );

  it.each(['recovery_result', 'terminal_update', 'terminal_committed', 'business_updated'])(
    'converges if recovery itself is killed at %s', async point => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-recovery-crash-'));
      const children: ChildProcess[] = [];
      try {
        const seed = child(directory, 'seed', 'effect_fsynced'); children.push(seed.process);
        await seed.message; await kill(seed.process);
        const interrupted = child(directory, 'recover', point); children.push(interrupted.process);
        expect((await interrupted.message).checkpoint).toBe(point); await kill(interrupted.process);
        if (point === 'terminal_update') {
          const database = new DatabaseSync(path.join(directory, 'runtime.sqlite'));
          try {
            const operation = database.prepare("SELECT state_json FROM operations WHERE id = 'old'").get();
            expect(JSON.parse(String(operation!.state_json)).phase).toBe('tools');
            expect(database.prepare("SELECT current_operation_id FROM lanes WHERE session_id = 's' AND name = 'main'").get()).toMatchObject({ current_operation_id: 'old' });
          } finally { database.close(); }
        }
        const recovered = child(directory, 'recover'); children.push(recovered.process);
        const result = await recovered.message; await recovered.exit;
        expect(result.effects).toBe(1);
        expect(result.recoveredProviderCalls).toBe(0);
        expect(result.old.find(run => run.id === 'old')?.status).toBe('interrupted');
        expect(result.result.status).toBe('completed');
        expect(result.integrity.integrity_check).toBe('ok');
        const repeated = child(directory, 'recover'); children.push(repeated.process);
        const second = await repeated.message; await repeated.exit;
        expect(second.ids).toEqual(result.ids); expect(second.effects).toBe(1);
      } finally {
        await Promise.all(children.map(kill)); await rm(directory, { recursive: true, force: true });
      }
    }, 60000
  );
});
