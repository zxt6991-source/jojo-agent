import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WorkflowRunSnapshot } from '@desktop-agent/contracts';
import { WorkflowCard } from './WorkflowCard.js';

describe('WorkflowCard', () => {
  it('renders run metadata, structured errors, and the maximum 32-step list', () => {
    const createdAt = '2026-08-16T10:00:00.000Z';
    const workflow: WorkflowRunSnapshot = {
      id: 'wf_render_32', sessionId: 'session', name: 'Large workflow', state: 'running', revision: 1,
      createdAt, startedAt: createdAt, usage: {
        inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 0, cacheWriteInputTokens: 0
      },
      steps: Array.from({ length: 32 }, (_, index) => ({
        id: `step_${index + 1}`,
        state: index === 0 ? 'failed' as const : 'pending' as const,
        attempt: 1,
        createdAt,
        ...(index === 0 ? { errorCode: 'provider_timeout' as const, error: 'Provider timed out.' } : {}),
        incomplete: index === 0,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 }
      })),
      failedStepIds: ['step_1'], blockedStepIds: [], incomplete: true
    };
    const html = renderToStaticMarkup(React.createElement(WorkflowCard, {
      workflow,
      onCancel: async () => undefined,
      onResume: async () => undefined
    }));
    expect(html).toContain('wf_render_32');
    expect(html).toContain('开始于');
    expect(html).toContain('provider_timeout');
    expect(html.match(/class="workflow-step /gu)).toHaveLength(32);
  });
});
