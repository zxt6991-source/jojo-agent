import { describe, expect, it } from 'vitest';
import { withTimeout } from './shutdown.js';

describe('shutdown timeout', () => {
  it('returns completed shutdown work', async () => {
    await expect(withTimeout(Promise.resolve('done'), 1_000)).resolves.toBe('done');
  });

  it('uses the stable timeout exit code', async () => {
    await expect(withTimeout(new Promise(() => undefined), 1)).rejects.toMatchObject({
      code: 'SERVER_SHUTDOWN_TIMEOUT', exitCode: 8
    });
  });
});
