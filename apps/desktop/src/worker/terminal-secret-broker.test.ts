import { describe, expect, it, vi } from 'vitest';
import { InteractiveTerminalSecretBroker } from './terminal-secret-broker';

describe('InteractiveTerminalSecretBroker', () => {
  it('uses configured desktop secrets without prompting', async () => {
    const emit = vi.fn();
    const broker = new InteractiveTerminalSecretBroker(emit);
    broker.replace({ WEREAD_API_KEY: 'saved-value' });

    await expect(broker.resolve(
      { provider: 'desktop', key: 'WEREAD_API_KEY' },
      { purpose: 'Terminal', sessionId: 'session-1' }
    )).resolves.toMatchObject({ value: 'saved-value' });
    expect(emit).not.toHaveBeenCalled();
  });

  it('prompts by name and resolves without exposing the value in the request', async () => {
    const emit = vi.fn();
    const broker = new InteractiveTerminalSecretBroker(emit);
    const lease = broker.resolve(
      { provider: 'desktop', key: 'WEREAD_API_KEY' },
      { purpose: 'Terminal command', sessionId: 'session-1' }
    );
    const request = emit.mock.calls[0]?.[0];
    expect(request).toMatchObject({ sessionId: 'session-1', name: 'WEREAD_API_KEY' });
    expect(JSON.stringify(request)).not.toContain('secret-value');
    broker.resolveRequest(request.requestId, 'secret-value');
    await expect(lease).resolves.toMatchObject({ value: 'secret-value' });
  });

  it('rejects pending requests when the session is cancelled', async () => {
    const broker = new InteractiveTerminalSecretBroker(() => undefined);
    const lease = broker.resolve(
      { provider: 'desktop', key: 'TOKEN' },
      { purpose: 'Terminal command', sessionId: 'session-1' }
    );
    broker.cancelSession('session-1');
    await expect(lease).rejects.toMatchObject({ code: 'terminal_secret_unavailable' });
  });
});
