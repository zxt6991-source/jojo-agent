import type { IsolationSnapshot } from '@desktop-agent/contracts';

export type IsolationPrepareRequest = {
  ownerId: string;
  sessionId: string;
  workingDirectory: string;
  branchHint?: string;
};

export type IsolationContext = {
  id: string;
  type: 'worktree';
  ownerId: string;
  sessionId: string;
  sourceRoot: string;
  repoRoot: string;
  workingDirectory: string;
  worktreePath: string;
  branch: string;
  headCommit: string;
  created: true;
};

export type IsolationManagerOptions = {
  worktreeRoot: string;
};

export function copyIsolationSnapshot(snapshot: IsolationSnapshot): IsolationSnapshot {
  return {
    ...snapshot,
    changedFiles: [...snapshot.changedFiles]
  };
}
