import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TeamSnapshot } from '@desktop-agent/contracts';
import { SqliteTeamStore } from '../src/sqlite-team-store.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function team(): TeamSnapshot {
  const now = new Date().toISOString();
  return {
    id: 'engineering', name: 'Engineering', workspace: '/workspace', workspaceKey: 'workspace-key',
    runtimeSessionId: 'team:workspace:engineering', maxConcurrency: 3, revision: 1,
    members: [{
      id: 'architect', name: 'Architect', profile: 'explore', laneId: 'member:architect',
      state: 'idle', revision: 1, createdAt: now, updatedAt: now
    }],
    createdAt: now, updatedAt: now
  };
}

describe('SqliteTeamStore', () => {
  it('persists teams, tasks, and unread inbox messages across instances', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-team-store-'));
    temporaryDirectories.push(directory);
    const file = path.join(directory, 'teams.sqlite');
    const first = new SqliteTeamStore(file);
    await first.createTeam(team());
    const now = new Date().toISOString();
    await first.createTask({
      id: 'tt_1', teamId: 'engineering', memberId: 'architect', input: 'Inspect runtime',
      state: 'queued', providerId: 'provider', model: 'model',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
      incomplete: false, createdAt: now
    });
    await first.enqueueMessage({
      id: 'tm_1', teamId: 'engineering', senderKind: 'main', recipientMemberId: 'architect',
      kind: 'note', content: 'Remember EventStore.', status: 'unread', createdAt: now
    });

    const reopened = new SqliteTeamStore(file);
    const loaded = await reopened.getTeam('engineering');
    expect(loaded?.members[0]?.laneId).toBe('member:architect');
    expect((await reopened.getTask('tt_1'))?.state).toBe('queued');
    expect(await reopened.listInbox({ teamId: 'engineering', memberId: 'architect' })).toHaveLength(1);
    await reopened.updateTeam({ ...loaded!, name: 'Engineering Updated', revision: 2, updatedAt: new Date().toISOString() });
    expect((await reopened.getTask('tt_1'))?.state).toBe('queued');
    expect(await reopened.listInbox({ teamId: 'engineering', memberId: 'architect' })).toHaveLength(1);
    await reopened.markMessageRead('tm_1');
    expect(await reopened.listInbox({ teamId: 'engineering', memberId: 'architect' })).toHaveLength(0);
    expect(await reopened.listInbox({ teamId: 'engineering', memberId: 'architect', includeRead: true })).toHaveLength(1);
  });
});
