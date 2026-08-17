import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScriptedProvider } from '@desktop-agent/agent-core';
import { WorkflowDefinitionSchema, type ProviderConfig } from '@desktop-agent/contracts';
import {
  AgentExecutionScheduler,
  IsolationManager,
  SubAgentManager,
  WorkflowEngine
} from '@desktop-agent/orchestration';
import { createDesktopLeafAgentRunner } from './orchestration-runtime.js';

const managers: IsolationManager[] = [];

afterEach(async () => {
  while (managers.length > 0) {
    await managers.pop()!.cleanupAll();
  }
});

const providerConfig: ProviderConfig = {
  id: 'e2e',
  name: 'E2E',
  protocol: 'openai_chat_completions',
  baseUrl: 'https://example.test/v1',
  model: 'e2e-model',
  models: ['e2e-model'],
  contextWindowTokens: 128_000,
  maxOutputTokens: 4_096,
  hasApiKey: true
};

function git(directory: string, args: string[]): string {
  return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' });
}

function fingerprint(repo: string): string {
  return `${git(repo, ['rev-parse', 'HEAD']).trim()}\n${git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'])}`;
}

async function createRepo(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-write-e2e-repo-'));
  const template = await mkdtemp(path.join(os.tmpdir(), 'jojo-write-e2e-git-'));
  try {
    git(directory, ['init', '--initial-branch=main', `--template=${template}`]);
  } catch {
    git(directory, ['init', `--template=${template}`]);
    git(directory, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  }
  git(directory, ['config', 'user.email', 'jojo-agent@test']);
  git(directory, ['config', 'user.name', 'Jojo Agent Test']);
  await writeFile(path.join(directory, 'README.md'), 'hello\n');
  git(directory, ['add', '.']);
  git(directory, ['commit', '-m', 'init']);
  return directory;
}

async function createHarness() {
  const repo = await createRepo();
  const worktreeRoot = await mkdtemp(path.join(os.tmpdir(), 'jojo-write-e2e-wt-'));
  const trashDirectory = await mkdtemp(path.join(os.tmpdir(), 'jojo-write-e2e-trash-'));
  const isolation = new IsolationManager({ worktreeRoot });
  managers.push(isolation);
  const runner = createDesktopLeafAgentRunner({
    trashDirectory,
    resolveProvider: () => ({ config: providerConfig, apiKey: 'test-key' }),
    createModelProvider: ({ request }) => {
      const stepId = request.id.split(':').at(-1) ?? 'edit';
      return new ScriptedProvider([
        [
          {
            type: 'tool_call_completed',
            call: {
              id: `write-${stepId}`,
              name: 'write_file',
              input: { path: `${stepId}.ts`, content: `export const ${stepId.replace(/[^A-Za-z0-9]/gu, '_')} = 1;\n` }
            }
          },
          { type: 'response_completed', stopReason: 'tool_calls' }
        ],
        [
          { type: 'text_delta', text: `wrote ${stepId}.ts` },
          { type: 'response_completed', stopReason: 'stop' }
        ]
      ]);
    }
  });
  return { repo, isolation, runner };
}

describe('Electron worker writable agents', () => {
  it('runs three general agents through the desktop runner, writes via write_file, and never touches the main tree', async () => {
    const { repo, isolation, runner } = await createHarness();
    const before = fingerprint(repo);
    const engine = new WorkflowEngine(runner, new AgentExecutionScheduler(4), { isolation });
    const final = await engine.run({
      id: 'wf_write_e2e',
      sessionId: 'session',
      workingDirectory: repo,
      providerId: 'e2e',
      model: 'e2e-model',
      args: {},
      definition: WorkflowDefinitionSchema.parse({
        schemaVersion: 1,
        name: 'parallel writes',
        maxConcurrency: 3,
        steps: [
          { id: 'auth', type: 'agent', profile: 'general', task: 'Fix auth' },
          { id: 'network', type: 'agent', profile: 'general', task: 'Fix network' },
          { id: 'storage', type: 'agent', profile: 'general', task: 'Fix storage' }
        ]
      }),
      createdAt: new Date().toISOString()
    }, new AbortController().signal, { onChanged: () => undefined, onLog: () => undefined });

    expect(final.state).toBe('completed');
    expect(final.steps.map((step) => step.isolation?.hasChanges)).toEqual([true, true, true]);
    expect(final.steps.every((step) => step.isolation?.cleanedUp === false)).toBe(true);
    expect(final.steps.every((step) => step.isolation?.branch.startsWith('jojo/'))).toBe(true);
    expect(final.steps.map((step) => step.isolation?.changedFiles[0]).sort()).toEqual(['auth.ts', 'network.ts', 'storage.ts']);
    expect(final.steps.every((step) => step.isolation?.diff?.includes('export const'))).toBe(true);
    expect(fingerprint(repo)).toBe(before);
    await expect(readFile(path.join(repo, 'README.md'), 'utf8')).resolves.toBe('hello\n');
  });

  it('lets a writable sub-agent write inside its worktree and refuses an escaped path', async () => {
    const { repo, isolation } = await createHarness();
    const before = fingerprint(repo);
    const outside = await mkdtemp(path.join(os.tmpdir(), 'jojo-write-e2e-outside-'));
    const escapedRunner = createDesktopLeafAgentRunner({
      trashDirectory: await mkdtemp(path.join(os.tmpdir(), 'jojo-write-e2e-trash-')),
      resolveProvider: () => ({ config: providerConfig, apiKey: 'test-key' }),
      createModelProvider: () => new ScriptedProvider([
        [
          {
            type: 'tool_call_completed',
            call: {
              id: 'escape-write',
              name: 'write_file',
              input: { path: path.join(outside, 'secret.txt'), content: 'leaked\n' }
            }
          },
          { type: 'response_completed', stopReason: 'tool_calls' }
        ],
        [
          { type: 'text_delta', text: 'attempted escape' },
          { type: 'response_completed', stopReason: 'stop' }
        ]
      ])
    });
    const manager = new SubAgentManager(escapedRunner, new AgentExecutionScheduler(1), () => undefined, { isolation });
    const agent = manager.start({
      sessionId: 'session',
      workingDirectory: repo,
      task: 'Write a secret outside the workspace',
      profile: 'general',
      providerId: 'e2e',
      model: 'e2e-model'
    });
    const [finished] = await manager.wait([agent.id], new AbortController().signal, 10_000);
    expect(finished?.state).toBe('idle');
    await vi.waitFor(() => expect(manager.get(agent.id)?.isolation).toBeDefined());
    expect(manager.get(agent.id)?.isolation?.hasChanges).toBe(false);
    expect(fingerprint(repo)).toBe(before);
    await expect(readFile(path.join(outside, 'secret.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
