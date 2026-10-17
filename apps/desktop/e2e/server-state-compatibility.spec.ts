import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { SERVER_STATE_SCHEMA_SQL } from '../../../packages/storage/src/server-state-schema';
import {
  HISTORICAL_CHANNEL_BINDING, HISTORICAL_CHANNEL_INSTANCE, readHistoricalChannelState, seedHistoricalChannelSchema
} from './helpers/channel-schema-v2';
import { launchElectron } from './helpers/launch-electron';
import { readHistoricalMemoryState, seedHistoricalMemorySchema } from './helpers/memory-schema-v2';

test('opens known application, channel and memory schemas without losing history across runs and restart', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-server-state-v8-'));
  const databasePath = path.join(directory, 'runtime', 'application.sqlite');
  const channelDatabasePath = path.join(directory, 'runtime', 'channels.sqlite');
  const memoryDatabasePath = path.join(directory, 'runtime', 'memory.sqlite');
  const historyId = 'historical-personal-session';
  const createdAt = new Date().toISOString();
  const historicalMessage = {
    id: 'historical-assistant-message', role: 'assistant',
    content: [{ type: 'text', text: 'A preserved historical reply' }], createdAt
  };
  const personalContext = JSON.stringify({ goal: 'Preserve historical context', notes: ['Offline fixture'] });
  const project = JSON.stringify({ workingDirectory: directory, projectBound: false });
  await mkdir(path.dirname(databasePath), { recursive: true });
  await mkdir(path.join(directory, 'sessions'));
  await writeFile(path.join(directory, 'sessions', `${historyId}.jsonl`), [
    { schemaVersion: 1, type: 'meta', session: {
      id: historyId, title: 'Historical conversation', workingDirectory: directory,
      projectBound: false, createdAt, updatedAt: createdAt
    } },
    { schemaVersion: 1, type: 'message', message: historicalMessage }
  ].map(record => JSON.stringify(record)).join('\n') + '\n');
  const fixture = new DatabaseSync(databasePath);
  try {
    fixture.exec(SERVER_STATE_SCHEMA_SQL);
    fixture.exec(`
      PRAGMA user_version = 6;
      ALTER TABLE server_sessions ADD COLUMN role_id TEXT
        CHECK(role_id IS NULL OR role_id IN ('personal', 'research', 'document', 'coding'));
      ALTER TABLE server_sessions ADD COLUMN personal_context_json TEXT
        CHECK(personal_context_json IS NULL OR json_valid(personal_context_json));
      PRAGMA user_version = 8;
    `);
    fixture.prepare(`INSERT INTO server_sessions
      (session_id, state, title, created_at, updated_at, role_id, personal_context_json)
      VALUES (?, 'active', 'Historical conversation', ?, ?, 'personal', ?)`)
      .run(historyId, Date.now(), Date.now(), personalContext);
    fixture.prepare('INSERT INTO application_session_projects(session_id, metadata_json) VALUES (?, ?)')
      .run(historyId, project);
  } finally { fixture.close(); }
  seedHistoricalChannelSchema(channelDatabasePath, historyId, createdAt);
  const expectedChannels = readHistoricalChannelState(channelDatabasePath);
  expect(expectedChannels.version).toBe(2);
  expect(expectedChannels.outboxColumns.slice(-2)).toEqual(['batch_id', 'part_index']);
  expect(expectedChannels.pairingForeignKeys).toEqual([]);
  seedHistoricalMemorySchema(memoryDatabasePath, historyId, createdAt);
  const expectedMemory = readHistoricalMemoryState(memoryDatabasePath);
  expect(expectedMemory.version).toBe(2);
  expect(expectedMemory.scope).toMatchObject({ kind: 'space', content_version: 7, dirty: 1 });
  expect(expectedMemory.entries).toHaveLength(1);

  const readHistory = () => {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      return {
        version: database.prepare('PRAGMA user_version').get()?.user_version,
        session: database.prepare('SELECT title, role_id, personal_context_json FROM server_sessions WHERE session_id = ?').get(historyId),
        project: database.prepare('SELECT metadata_json FROM application_session_projects WHERE session_id = ?').get(historyId)?.metadata_json
      };
    } finally { database.close(); }
  };
  const expectedHistory = {
    version: 8,
    session: { title: 'Renamed historical conversation', role_id: 'personal', personal_context_json: personalContext },
    project
  };
  let launched = await launchElectron(directory);
  let open = true;
  const assertServices = async () => {
    const settings = await launched.page.evaluate(() => window.desktopAgent.getChannelSettings());
    expect(settings.instances.find(instance => instance.id === HISTORICAL_CHANNEL_INSTANCE))
      .toMatchObject({ kind: 'feishu', enabled: false });
    expect(settings.bindings.find(binding => binding.id === HISTORICAL_CHANNEL_BINDING))
      .toMatchObject({ instanceId: HISTORICAL_CHANNEL_INSTANCE, routing: { sessionId: historyId } });
    expect(settings.deliveries).toHaveLength(3);
    expect(await launched.page.evaluate(() => window.desktopAgent.listSchedules())).toEqual([]);
    const memory = await launched.page.evaluate(() => window.desktopAgent.getMemoryStatus());
    expect(memory.root).toBe(path.join(directory, 'memory'));
    expect(memory.scopes.some(scope => scope.kind === 'global')).toBe(true);
    expect(readHistoricalChannelState(channelDatabasePath)).toEqual(expectedChannels);
    expect(readHistoricalMemoryState(memoryDatabasePath)).toEqual(expectedMemory);
  };
  try {
    await assertServices();
    const sessions = await launched.page.evaluate(() => window.desktopAgent.listSessions());
    expect(sessions.find(session => session.id === historyId)).toMatchObject({
      title: 'Historical conversation', workingDirectory: directory, projectBound: false
    });
    expect(await launched.page.evaluate(sessionId => window.desktopAgent.loadMessages(sessionId), historyId))
      .toEqual([historicalMessage]);
    await launched.page.evaluate(sessionId => window.desktopAgent.renameSession({
      sessionId, title: 'Renamed historical conversation'
    }), historyId);
    expect(readHistory()).toEqual(expectedHistory);

    const created = await launched.page.evaluate(async () => {
      const session = await window.desktopAgent.createSession({ title: 'Schema 8 offline run' });
      const settings = await window.desktopAgent.getSettings();
      const provider = settings.providers.find(candidate => candidate.id === settings.activeProviderId)!;
      await window.desktopAgent.startTurn({
        sessionId: session!.id, text: 'E2E: text', providerId: provider.id, model: provider.model
      });
      return session!;
    });
    await expect.poll(() => {
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        return database.prepare('SELECT status FROM server_runs WHERE session_id = ? ORDER BY created_at DESC LIMIT 1')
          .get(created.id)?.status;
      } finally { database.close(); }
    }).toBe('completed');
    expect(readHistory()).toEqual(expectedHistory);
    expect(readHistoricalChannelState(channelDatabasePath)).toEqual(expectedChannels);
    expect(readHistoricalMemoryState(memoryDatabasePath)).toEqual(expectedMemory);

    await launched.app.close();
    open = false;
    launched = await launchElectron(directory);
    open = true;
    await assertServices();
    const restarted = await launched.page.evaluate(() => window.desktopAgent.listSessions());
    expect(restarted.find(session => session.id === historyId)?.title).toBe('Renamed historical conversation');
    expect(restarted.some(session => session.id === created.id)).toBe(true);
    expect(await launched.page.evaluate(sessionId => window.desktopAgent.loadMessages(sessionId), historyId))
      .toEqual([historicalMessage]);
    expect(readHistory()).toEqual(expectedHistory);
  } finally {
    if (open) await launched.app.close();
  }
});
