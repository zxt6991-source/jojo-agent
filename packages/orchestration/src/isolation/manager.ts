import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { IsolationSnapshot } from '@desktop-agent/contracts';
import { OrchestrationError } from '../errors.js';
import {
  addGitWorktree,
  deleteGitBranch,
  inspectGitWorktree,
  removeGitWorktree,
  resolveGitRepository,
  type WorktreeInspection
} from './git-worktree.js';
import { assertManagedPath, canonicalizeExisting, isolationSegment, isInside } from './paths.js';
import type { IsolationContext, IsolationManagerOptions, IsolationPrepareRequest } from './types.js';

class RepoLock {
  private chain = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(operation, operation);
    this.chain = result.then(() => undefined, () => undefined);
    return result;
  }
}

export class IsolationManager {
  private readonly worktreeRoot: string;
  private readonly contexts = new Map<string, IsolationContext>();
  private readonly locks = new Map<string, RepoLock>();
  private rootReady: Promise<string> | undefined;

  constructor(options: IsolationManagerOptions) {
    this.worktreeRoot = path.resolve(options.worktreeRoot);
  }

  async prepare(request: IsolationPrepareRequest): Promise<IsolationContext> {
    const repository = await resolveGitRepository(request.workingDirectory);
    const root = await this.ensureRoot();
    const id = `iso_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const branch = `jojo/${isolationSegment(request.branchHint ?? request.ownerId)}-${id.slice(4, 12)}`;
    const worktreePath = path.join(root, isolationSegment(request.sessionId, 'session'), id);
    if (!isInside(root, worktreePath) || worktreePath === root) {
      throw new OrchestrationError('worktree_path_invalid', 'Generated worktree path escaped the isolation root.');
    }

    await this.lock(repository.repoRoot).run(async () => {
      await addGitWorktree({
        repoRoot: repository.repoRoot,
        worktreePath,
        branch,
        headCommit: repository.headCommit
      });
    });

    const resolvedWorktree = await assertManagedPath(root, worktreePath);
    const workingDirectory = repository.relativeWorkspace
      ? path.join(resolvedWorktree, repository.relativeWorkspace)
      : resolvedWorktree;
    if (!isInside(resolvedWorktree, workingDirectory)) {
      await this.unsafeCleanup(repository.repoRoot, resolvedWorktree, branch);
      throw new OrchestrationError('worktree_path_invalid', 'Mapped agent working directory escaped the worktree.');
    }

    const context: IsolationContext = {
      id,
      type: 'worktree',
      ownerId: request.ownerId,
      sessionId: request.sessionId,
      sourceRoot: repository.sourceRoot,
      repoRoot: repository.repoRoot,
      workingDirectory,
      worktreePath: resolvedWorktree,
      branch,
      headCommit: repository.headCommit,
      created: true
    };
    this.contexts.set(id, context);
    return { ...context };
  }

  async inspect(context: IsolationContext): Promise<IsolationSnapshot> {
    const live = this.requireContext(context.id);
    try {
      return this.snapshot(live, await inspectGitWorktree(live.worktreePath), false);
    } catch {
      return this.snapshot(live, { changedFiles: [], hasChanges: true, truncated: false }, false);
    }
  }

  async finish(context: IsolationContext): Promise<IsolationSnapshot> {
    const live = this.requireContext(context.id);
    let inspection: Awaited<ReturnType<typeof inspectGitWorktree>>;
    try {
      inspection = await inspectGitWorktree(live.worktreePath);
    } catch {
      return this.snapshot(live, {
        changedFiles: [],
        hasChanges: true,
        truncated: false
      }, false);
    }
    if (inspection.hasChanges) return this.snapshot(live, inspection, false);
    await this.cleanup(live);
    return this.snapshot(live, inspection, true);
  }

  async cleanup(context: IsolationContext, options: { force?: boolean } = {}): Promise<void> {
    const live = this.contexts.get(context.id);
    if (!live) return;
    if (!options.force) {
      const inspection = await inspectGitWorktree(live.worktreePath).catch(() => ({ hasChanges: true }));
      if (inspection.hasChanges) {
        throw new OrchestrationError(
          'worktree_cleanup_failed',
          'Refusing to delete a worktree that still has reviewable changes.'
        );
      }
    }
    await this.unsafeCleanup(live.repoRoot, live.worktreePath, live.branch);
    this.contexts.delete(live.id);
  }

  async cleanupAll(): Promise<void> {
    for (const context of [...this.contexts.values()]) {
      await this.cleanup(context, { force: true }).catch(() => undefined);
    }
  }

  private snapshot(
    context: IsolationContext,
    inspection: WorktreeInspection,
    cleanedUp: boolean
  ): IsolationSnapshot {
    return {
      type: 'worktree',
      workingDirectory: context.workingDirectory,
      worktreePath: context.worktreePath,
      branch: context.branch,
      commit: context.headCommit,
      changedFiles: [...inspection.changedFiles],
      ...(inspection.diffStat ? { diffStat: inspection.diffStat } : {}),
      ...(inspection.diff ? { diff: inspection.diff } : {}),
      hasChanges: inspection.hasChanges,
      cleanedUp,
      truncated: inspection.truncated
    };
  }

  private requireContext(id: string): IsolationContext {
    const live = this.contexts.get(id);
    if (!live) throw new OrchestrationError('worktree_path_invalid', `Unknown isolation context: ${id}`);
    return live;
  }

  private async unsafeCleanup(repoRoot: string, worktreePath: string, branch: string): Promise<void> {
    const root = await this.ensureRoot();
    await assertManagedPath(root, worktreePath);
    if (worktreePath === repoRoot || isInside(worktreePath, repoRoot)) {
      throw new OrchestrationError('worktree_path_invalid', 'Refusing to delete the source Git repository.');
    }
    await this.lock(repoRoot).run(async () => {
      await removeGitWorktree(repoRoot, worktreePath);
      await deleteGitBranch(repoRoot, branch);
    });
  }

  private async ensureRoot(): Promise<string> {
    this.rootReady ??= mkdir(this.worktreeRoot, { recursive: true }).then(() => canonicalizeExisting(this.worktreeRoot));
    return this.rootReady;
  }

  private lock(repoRoot: string): RepoLock {
    const existing = this.locks.get(repoRoot);
    if (existing) return existing;
    const created = new RepoLock();
    this.locks.set(repoRoot, created);
    return created;
  }
}
