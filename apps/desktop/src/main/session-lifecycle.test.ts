import { describe, expect, it } from 'vitest';
import { SessionLifecycleManager } from './session-lifecycle';

describe('SessionLifecycleManager', () => {
  it('closes the mutation gate synchronously when deletion begins', () => {
    const lifecycle = new SessionLifecycleManager();
    const lease = lifecycle.beginDelete('session-a');

    expect(lifecycle.state('session-a')).toBe('deleting');
    expect(() => lifecycle.assertMutable('session-a')).toThrow(/session_deleting/);
    expect(() => lifecycle.beginDelete('session-a')).toThrow(/session_deleting/);

    lease.commit();
    expect(lifecycle.state('session-a')).toBe('deleted');
    expect(() => lifecycle.assertMutable('session-a')).toThrow(/session_unavailable/);
  });

  it('reopens the gate when deletion fails', () => {
    const lifecycle = new SessionLifecycleManager();
    lifecycle.beginDelete('session-a').rollback();
    expect(() => lifecycle.assertMutable('session-a')).not.toThrow();
  });
});
