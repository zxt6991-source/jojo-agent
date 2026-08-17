import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowDefinitionSchema } from '@desktop-agent/contracts';
import {
  AgentExecutionScheduler,
  emptyUsage,
  IsolationManager,
  resolveIsolationType,
  type LeafAgentRunner,
  WorkflowEngine
} from '../src/index.js';
import { createBuiltinAgentProfileRegistry } from '../src/subagent/profile-registry.js';
import { git, repositoryIndexFingerprint } from '../src/isolation/git-worktree.js';

const managers: IsolationManager[] = [];

afterEach(async () => {
  while (managers.length > 0) {
    await managers.pop()!.cleanupAll();
  }
});

async function createRepo(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-isolation-repo-'));
  const template = await mkdtemp(path.join(os.tmpdir(), 'jojo-git-template-'));
  try {
    await git(directory, ['init', '--initial-branch=main', `--template=${template}`]);
  } catch {
    await git(directory, ['init', `--template=${template}`]);
    await git(directory, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  }
  await git(directory, ['config', 'user.email', 'jojo-agent@test']);
  await git(directory, ['config', 'user.name', 'Jojo Agent Test']);
  await writeFile(path.join(directory, 'README.md'), 'hello\n');
  await git(directory, ['add', '.']);
  await git(directory, ['commit', '-m', 'init']);
  return directory;
}

async function createManager(): Promise<{ repo: string; worktreeRoot: string; isolation: IsolationManager }> {
  const repo = await createRepo();
  const worktreeRoot = await mkdtemp(path.join(os.tmpdir(), 'jojo-isolation-wt-'));
  const isolation = new IsolationManager({ worktreeRoot });
  managers.push(isolation);
  return { repo, worktreeRoot, isolation };
}

describe('resolveIsolationType', () => {
  const registry = createBuiltinAgentProfileRegistry();

  it('defaults writable profiles to worktree and read-only profiles to none', () => {
    expect(resolveIsolationType({ profile: registry.get('general') })).toBe('worktree');
    expect(resolveIsolationType({ profile: registry.get('explore') })).toBe('none');
    expect(resolveIsolationType({ profile: registry.get('general'), requestReadOnly: true })).toBe('none');
  });

  it('rejects explicit none for writable agents', () => {
    expect(() => resolveIsolationType({
      profile: registry.get('general'),
      requestedType: 'none'
    })).toThrowError(expect.objectContaining({ code: 'isolation_required' }));
  });
});

describe('IsolationManager', () => {
  it('creates a worktree, cleans it up when there are no changes, and leaves the main worktree untouched', async () => {
    const { repo, isolation } = await createManager();
    const before = await repositoryIndexFingerprint(repo);
    const context = await isolation.prepare({
      ownerId: 'sa_clean', sessionId: 'session', workingDirectory: repo, branchHint: 'clean'
    });
    expect(context.workingDirectory).not.toBe(repo);
    expect(context.branch.startsWith('jojo/')).toBe(true);
    const finished = await isolation.finish(context);
    expect(finished).toMatchObject({ hasChanges: false, cleanedUp: true });
    expect(await repositoryIndexFingerprint(repo)).toBe(before);
    const branches = await git(repo, ['branch', '--list', context.branch]);
    expect(branches.trim()).toBe('');
  });

  it('keeps reviewable changes on an isolated branch without merging or touching the main index', async () => {
    const { repo, isolation } = await createManager();
    const before = await repositoryIndexFingerprint(repo);
    const context = await isolation.prepare({
      ownerId: 'sa_dirty', sessionId: 'session', workingDirectory: repo, branchHint: 'dirty'
    });
    await writeFile(path.join(context.workingDirectory, 'hotfix.txt'), 'isolated change\n');
    const finished = await isolation.finish(context);
    expect(finished.hasChanges).toBe(true);
    expect(finished.cleanedUp).toBe(false);
    expect(finished.changedFiles).toContain('hotfix.txt');
    expect(finished.diff).toContain('isolated change');
    expect(await repositoryIndexFingerprint(repo)).toBe(before);
    await expect(git(repo, ['merge-base', '--is-ancestor', context.branch, 'HEAD'])).resolves.toBe('');
    const branches = await git(repo, ['branch', '--list', context.branch]);
    expect(branches).toContain(context.branch);
  });

  it('runs three writable worktrees in parallel without clobbering the source repository', async () => {
    const { repo, isolation } = await createManager();
    const before = await repositoryIndexFingerprint(repo);
    const contexts = await Promise.all(['auth', 'network', 'storage'].map((name) => isolation.prepare({
      ownerId: `sa_${name}`, sessionId: 'session', workingDirectory: repo, branchHint: name
    })));
    expect(new Set(contexts.map((context) => context.workingDirectory)).size).toBe(3);
    await Promise.all(contexts.map((context, index) => writeFile(
      path.join(context.workingDirectory, `${['auth', 'network', 'storage'][index]}.ts`),
      `export const value = ${index};\n`
    )));
    const results = await Promise.all(contexts.map((context) => isolation.finish(context)));
    expect(results.every((item) => item.hasChanges && !item.cleanedUp)).toBe(true);
    expect(results.map((item) => item.changedFiles[0]).sort()).toEqual(['auth.ts', 'network.ts', 'storage.ts']);
    expect(await repositoryIndexFingerprint(repo)).toBe(before);
  });

  it('maps a subdirectory workspace onto the matching worktree path', async () => {
    const { repo, isolation } = await createManager();
    const nested = path.join(repo, 'packages', 'core');
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, 'index.ts'), 'export {};\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'nested']);
    const context = await isolation.prepare({
      ownerId: 'sa_nested', sessionId: 'session', workingDirectory: nested, branchHint: 'nested'
    });
    expect(context.workingDirectory.endsWith(path.join('packages', 'core'))).toBe(true);
    await writeFile(path.join(context.workingDirectory, 'edit.ts'), 'ok\n');
    const finished = await isolation.finish(context);
    expect(finished.changedFiles.some((file) => file.endsWith('edit.ts'))).toBe(true);
  });

  it('returns a stable error when the working directory is not a git repository', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-isolation-nogit-'));
    const isolation = new IsolationManager({
      worktreeRoot: await mkdtemp(path.join(os.tmpdir(), 'jojo-isolation-wt-'))
    });
    managers.push(isolation);
    await expect(isolation.prepare({
      ownerId: 'sa_nogit', sessionId: 'session', workingDirectory: directory
    })).rejects.toMatchObject({ code: 'worktree_not_a_git_repository' });
  });

  it('refuses to clean up a worktree that still has reviewable changes', async () => {
    const { repo, isolation } = await createManager();
    const context = await isolation.prepare({
      ownerId: 'sa_keep', sessionId: 'session', workingDirectory: repo, branchHint: 'keep'
    });
    await writeFile(path.join(context.workingDirectory, 'keep.txt'), 'keep\n');
    await expect(isolation.cleanup(context)).rejects.toMatchObject({ code: 'worktree_cleanup_failed' });
    const finished = await isolation.finish(context);
    expect(finished.hasChanges).toBe(true);
  });
});

describe('WorkflowEngine isolation', () => {
  it('fails writable steps when isolation is not configured', async () => {
    const runner: LeafAgentRunner = { run: async () => ({ result: 'done', stopReason: 'stop', usage: emptyUsage(), incomplete: false }) };
    const final = await new WorkflowEngine(runner, new AgentExecutionScheduler(1)).run({
      id: 'wf_test', sessionId: 'session', workingDirectory: process.cwd(),
      providerId: 'provider', model: 'model', args: {},
      definition: WorkflowDefinitionSchema.parse({
        schemaVersion: 1, name: 'writable', steps: [{ id: 'edit', type: 'agent', profile: 'general', task: 'Edit' }]
      }),
      createdAt: new Date().toISOString()
    }, new AbortController().signal, { onChanged: () => undefined, onLog: () => undefined });
    expect(final.steps[0]).toMatchObject({ state: 'failed', errorCode: 'worktree_create_failed' });
  });

  it('fails writable steps that explicitly disable isolation', async () => {
    const runner: LeafAgentRunner = { run: async () => ({ result: 'done', stopReason: 'stop', usage: emptyUsage(), incomplete: false }) };
    const final = await new WorkflowEngine(runner, new AgentExecutionScheduler(1)).run({
      id: 'wf_test', sessionId: 'session', workingDirectory: process.cwd(),
      providerId: 'provider', model: 'model', args: {},
      definition: WorkflowDefinitionSchema.parse({
        schemaVersion: 1, name: 'writable',
        steps: [{ id: 'edit', type: 'agent', profile: 'general', isolation: { type: 'none' }, task: 'Edit' }]
      }),
      createdAt: new Date().toISOString()
    }, new AbortController().signal, { onChanged: () => undefined, onLog: () => undefined });
    expect(final.steps[0]).toMatchObject({ state: 'failed', errorCode: 'isolation_required' });
  });

  it('runs three writable agent steps in independent worktrees and never auto-merges', async () => {
    const { repo, isolation } = await createManager();
    const before = await repositoryIndexFingerprint(repo);
    const directories: string[] = [];
    const runner: LeafAgentRunner = {
      run: async (runRequest) => {
        directories.push(runRequest.workingDirectory);
        const stepId = runRequest.id.split(':').at(-1)!;
        await writeFile(path.join(runRequest.workingDirectory, `${stepId}.md`), `${stepId} change\n`);
        expect(runRequest.task).toContain('Do not merge into the default branch.');
        return { result: `edited ${stepId}`, stopReason: 'stop', usage: emptyUsage(), incomplete: false };
      }
    };
    const final = await new WorkflowEngine(runner, new AgentExecutionScheduler(4), { isolation }).run({
      id: 'wf_iso', sessionId: 'session', workingDirectory: repo,
      providerId: 'provider', model: 'model', args: {},
      definition: WorkflowDefinitionSchema.parse({
        schemaVersion: 1, name: 'parallel writes', maxConcurrency: 3,
        steps: [
          { id: 'auth', type: 'agent', profile: 'general', task: 'Fix auth' },
          { id: 'network', type: 'agent', profile: 'general', task: 'Fix network' },
          { id: 'storage', type: 'agent', profile: 'general', task: 'Fix storage' }
        ]
      }),
      createdAt: new Date().toISOString()
    }, new AbortController().signal, { onChanged: () => undefined, onLog: () => undefined });

    expect(final.state).toBe('completed');
    expect(new Set(directories).size).toBe(3);
    expect(directories.every((directory) => directory !== repo)).toBe(true);
    expect(final.steps.map((step) => step.isolation?.hasChanges)).toEqual([true, true, true]);
    expect(final.steps.every((step) => step.isolation?.cleanedUp === false)).toBe(true);
    expect(final.steps.every((step) => step.isolation?.branch.startsWith('jojo/'))).toBe(true);
    expect(await repositoryIndexFingerprint(repo)).toBe(before);
  });
});
