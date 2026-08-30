import { describe, expect, it } from 'vitest';
import type { RuntimeResolutionContext } from '@desktop-agent/agent-runtime';
import { DefaultPermissionRequestNormalizer } from '../src/index.js';

const context: RuntimeResolutionContext = {
  sessionId: 'session',
  laneId: 'main',
  runId: 'run',
  providerId: 'provider',
  model: 'model',
  workingDirectory: '/workspace',
  executionScope: { kind: 'workspace', workingDirectory: '/workspace' },
  actor: { kind: 'main' }
};

describe('scheduler permission normalization', () => {
  it.each(['schedule_list', 'schedule_get', 'schedule_runs'])('normalizes %s as an orchestration read', (name) => {
    const request = new DefaultPermissionRequestNormalizer().normalize({
      call: { id: 'call', name, input: {} },
      context,
      baseline: { decision: 'allow' }
    });
    expect(request.facts).toMatchObject({ source: 'orchestration', operations: ['read'], risk: 'low' });
  });

  it.each([
    'schedule_create', 'schedule_update', 'schedule_set_enabled', 'schedule_delete',
    'schedule_run_now', 'schedule_cancel_run'
  ])('normalizes %s as orchestration control', (name) => {
    const request = new DefaultPermissionRequestNormalizer().normalize({
      call: { id: 'call', name, input: {} },
      context,
      baseline: { decision: 'allow' }
    });
    expect(request.facts).toMatchObject({ source: 'orchestration', operations: ['control'], risk: 'low' });
  });
});
