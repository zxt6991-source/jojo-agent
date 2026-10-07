import { resolveWorkspaceRoot } from './workspace-paths.js';
const queues = new Map<string, Promise<void>>();
/** Serializes native mutations across tool instances in this host; canonical roots share a queue. */
export async function withWorkspaceMutationLock<T>(workingDirectory: string, execute: () => Promise<T>): Promise<T> {
  const root = await resolveWorkspaceRoot(workingDirectory);
  const previous = queues.get(root) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  queues.set(root, current);
  await previous;
  try { return await execute(); }
  finally { release(); if (queues.get(root) === current) queues.delete(root); }
}
