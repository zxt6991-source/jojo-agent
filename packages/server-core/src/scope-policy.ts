import { homedir } from 'node:os';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import type { CreateSessionInput } from '@desktop-agent/server-protocol';
import { ProtocolFailure } from './errors.js';

export class ScopePolicy {
  constructor(private readonly workspaceRoots: string[] = []) {}

  async authorize(input: CreateSessionInput): Promise<CreateSessionInput> {
    if (input.executionScope.kind !== 'workspace') return input;
    const workingDirectory = await this.authorizeWorkspaceRoot(input.executionScope.workingDirectory);
    return { ...input, executionScope: { kind: 'workspace', workingDirectory } };
  }

  async authorizeWorkspaceRoot(workingDirectory: string): Promise<string> {
    if (this.workspaceRoots.length === 0) {
      throw new ProtocolFailure({ code: 'workspace_not_allowed', message: 'Workspace sessions are not enabled.' });
    }
    let requested: string;
    try { requested = await realpath(workingDirectory); }
    catch {
      throw new ProtocolFailure({ code: 'workspace_not_allowed', message: 'The workspace does not exist.' });
    }
    const broad = [path.parse(requested).root, path.resolve(homedir())];
    let roots: string[];
    try { roots = await Promise.all(this.workspaceRoots.map(async (root) => realpath(root))); }
    catch {
      throw new ProtocolFailure({ code: 'workspace_not_allowed', message: 'A configured workspace root does not exist.' });
    }
    roots = roots.filter((root) => !broad.includes(root));
    if (broad.includes(requested) || !roots.some((root) => within(root, requested))) {
      throw new ProtocolFailure({ code: 'workspace_not_allowed', message: 'The workspace is outside the configured roots.' });
    }
    return requested;
  }
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
