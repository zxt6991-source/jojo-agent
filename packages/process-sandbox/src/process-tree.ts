import type { ChildProcess } from 'node:child_process';

export type ProcessTreeController = {
  terminate(pid: number): Promise<void>;
  kill(pid: number): Promise<void>;
};

function signalProcessTree(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform === 'win32') process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch { /* Process already exited. */ }
  }
}

export const defaultProcessTreeController: ProcessTreeController = {
  terminate: async (pid) => signalProcessTree(pid, 'SIGTERM'),
  kill: async (pid) => signalProcessTree(pid, 'SIGKILL')
};

export async function signalChildProcess(
  child: ChildProcess,
  signal: 'terminate' | 'kill',
  controller: ProcessTreeController = defaultProcessTreeController
): Promise<void> {
  if (!child.pid) return;
  await controller[signal](child.pid);
}
