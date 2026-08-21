import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteHookInvocationStore } from '../src/index.js';

const files: string[] = [];
afterEach(async () => { await Promise.all(files.splice(0).map((file) => rm(file, { force: true }))); });

describe('SqliteHookInvocationStore', () => {
  it('atomically creates and reuses completed durable invocations', async () => {
    const file = path.join(os.tmpdir(), `jojo-hook-store-${crypto.randomUUID()}.sqlite`);
    files.push(file, `${file}-shm`, `${file}-wal`);
    const first = new SqliteHookInvocationStore(file);
    const record = {
      id: 'operation:PreToolUse:call:user.guard',
      eventId: 'event-1',
      hookId: 'user.guard',
      event: 'PreToolUse' as const,
      sessionId: 'session-1',
      operationId: 'operation-1',
      subjectId: 'call-1',
      state: 'pending' as const
    };
    expect(await first.beginInvocation(record)).toBe('created');
    expect(await first.beginInvocation(record)).toBe('exists');
    await first.completeInvocation(record.id, { decision: 'block', reason: 'durable' });
    first.close();

    const reopened = new SqliteHookInvocationStore(file);
    expect(await reopened.getInvocation(record.id)).toMatchObject({
      state: 'completed', result: { decision: 'block', reason: 'durable' }
    });
    reopened.close();
  });
});
