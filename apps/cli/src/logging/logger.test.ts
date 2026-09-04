import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config/loader.js';
import { createLogger, flushLogger } from './logger.js';

describe('operational logger', () => {
  it('writes common fields and redacts sensitive values', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'jojo-log-'));
    const file = path.join(root, 'logs/server.log');
    const config = await loadConfig({
      homeDirectory: root,
      environment: {},
      cliOverrides: { logging: { file, format: 'json' } }
    });
    const logger = createLogger(config);
    logger.info({ event: 'test.event', authorization: 'Bearer abc', apiKey: 'sk-secret', nested: { token: 'nested-token' } });
    await flushLogger(logger);
    const content = await readFile(file, 'utf8');
    expect(content).toContain('test.event');
    expect(content).toContain('"service":"jojo"');
    expect(content).not.toContain('Bearer abc');
    expect(content).not.toContain('sk-secret');
    expect(content).not.toContain('nested-token');
  });
});
