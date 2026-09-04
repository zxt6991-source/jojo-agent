import { mkdtemp, writeFile } from 'node:fs/promises';
import { Writable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { serveCommand } from './serve.js';

describe('jojo serve --check', () => {
  it('validates configuration, storage, provider secret, and an ephemeral bind', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'jojo-serve-check-'));
    const file = path.join(root, 'config.yml');
    await writeFile(file, `server:\n  port: 0\nruntime:\n  dataDir: ./runtime\n  runDir: ./run\nprovider:\n  providers:\n    openai:\n      type: openai-compatible\n      baseUrl: https://api.openai.com/v1\n      apiKey:\n        literal: test-key\n`);
    let output = '';
    const stream = new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } });
    await serveCommand({ config: file, check: true }, stream);
    expect(output).toContain('OK config');
    expect(output).toContain('OK provider');
    expect(output).toContain('127.0.0.1:0');
  });
});
