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
      memory: {
        memorySnapshotId: 'snap_frozen', contentHash: 'hash',
        scopeVersions: { global: 2, prj_test: 5 }, createdAt: Date.parse(createdAt)
      },
      steps: Array.from({ length: 32 }, (_, index) => ({
        id: `step_${index + 1}`,
        ...(index === 0 ? { profile: 'code-review', model: 'review-model' } : {}),
        ...(index === 1 ? { type: 'tool' as const, tool: 'grep' as const } : {}),
        state: index === 0 ? 'failed' as const : 'pending' as const,
        attempt: index === 0 ? 2 : 1,
        createdAt,
        ...(index === 0 ? { errorCode: 'provider_timeout' as const, error: 'Provider timed out.' } : {}),
        ...(index === 0 ? {
          isolation: {
            type: 'worktree' as const,
            workingDirectory: '/tmp/wt/edit',
            worktreePath: '/tmp/wt/edit',
            branch: 'jojo/edit-abc',
            changedFiles: ['src/a.ts'],
            diffStat: ' src/a.ts | 2 ++',
            diff: '+export const a = 1;',
            hasChanges: true,
            cleanedUp: false,
            truncated: false
          }
        } : {}),
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
    expect(html).toContain('code-review · review-model');
    expect(html).toContain('tool:grep');
    expect(html).toContain('第 2 次尝试');
    expect(html).toContain('jojo/edit-abc');
    expect(html).toContain('待审查');
    expect(html).toContain('不自动合并');
    expect(html).toContain('Memory Snapshot');
    expect(html).toContain('snap_frozen');
    expect(html).toContain('frozen');
    expect(html.match(/class="workflow-step /gu)).toHaveLength(32);
  });

  it('nests foreach instances and shows foreach progress plus error codes', () => {
    const createdAt = '2026-08-16T10:00:00.000Z';
    const workflow: WorkflowRunSnapshot = {
      id: 'wf_foreach', sessionId: 'session', name: 'Foreach workflow', state: 'running', revision: 1,
      createdAt, startedAt: createdAt, usage: {
        inputTokens: 3, outputTokens: 1, cacheReadInputTokens: 0, cacheWriteInputTokens: 0
      },
      steps: [{
        id: 'review',
        type: 'foreach',
        state: 'failed',
        attempt: 1,
        createdAt,
        errorCode: 'foreach_item_limit',
        error: 'Foreach produced 9 items, which exceeds itemLimit 8.',
        incomplete: true,
        usage: { inputTokens: 3, outputTokens: 1, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
        instances: [
          {
            id: 'review__0', type: 'agent', profile: 'code-review', parentId: 'review', index: 0, item: 'a.ts',
            state: 'completed', attempt: 1, createdAt, incomplete: false,
            usage: { inputTokens: 2, outputTokens: 1, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 }
          },
          {
            id: 'review__1', type: 'agent', profile: 'code-review', parentId: 'review', index: 1, item: 'b.ts',
            state: 'pending', attempt: 1, createdAt, incomplete: false,
            usage: { inputTokens: 1, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 }
          }
        ]
      }],
      failedStepIds: ['review'], blockedStepIds: [], incomplete: true
    };
    const html = renderToStaticMarkup(React.createElement(WorkflowCard, {
      workflow,
      onCancel: async () => undefined,
      onResume: async () => undefined
    }));
    expect(html).toContain('foreach · 1/2');
    expect(html).toContain('review__0');
    expect(html).toContain('review__1');
    expect(html).toContain('foreach_item_limit');
    expect(html).toContain('workflow-step-instance');
  });

  it('renders skipped condition branches and nested workflow children', () => {
    const createdAt = '2026-08-16T10:00:00.000Z';
    const emptyUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 };
    const workflow: WorkflowRunSnapshot = {
      id: 'wf_control', sessionId: 'session', name: 'Control workflow', state: 'running', revision: 1,
      createdAt, startedAt: createdAt, usage: emptyUsage,
      steps: [
        {
          id: 'check', type: 'condition', state: 'completed', attempt: 1, createdAt, incomplete: false,
          structuredResult: { matched: true }, usage: emptyUsage
        },
        {
          id: 'app', type: 'agent', profile: 'explore', state: 'skipped', attempt: 1, createdAt, incomplete: false,
          stopReason: 'skipped', resourceGroup: 'main-worktree-writer', usage: emptyUsage
        },
        {
          id: 'security', type: 'workflow', workflow: 'inner-review', state: 'completed', attempt: 1, createdAt,
          incomplete: false, usage: { inputTokens: 2, outputTokens: 1, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
          child: {
            id: 'wf_control:security', sessionId: 'session', name: 'inner-review', state: 'completed', revision: 1,
            createdAt, usage: { inputTokens: 2, outputTokens: 1, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
            steps: [{
              id: 'work', type: 'agent', profile: 'code-review', state: 'completed', attempt: 1, createdAt,
              incomplete: false, usage: { inputTokens: 2, outputTokens: 1, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 }
            }],
            failedStepIds: [], blockedStepIds: [], incomplete: false
          }
        }
      ],
      failedStepIds: [], blockedStepIds: [], incomplete: false
    };
    const html = renderToStaticMarkup(React.createElement(WorkflowCard, {
      workflow,
      onCancel: async () => undefined,
      onResume: async () => undefined
    }));
    expect(html).toContain('condition');
    expect(html).toContain('已跳过');
    expect(html).toContain('group:main-worktree-writer');
    expect(html).toContain('workflow:inner-review');
    expect(html).toContain('work');
  });

  it('renders workflow budget remaining and budget exceeded error codes', () => {
    const createdAt = '2026-08-16T10:00:00.000Z';
    const workflow: WorkflowRunSnapshot = {
      id: 'wf_budget', sessionId: 'session', name: 'Budget workflow', state: 'running', revision: 1,
      createdAt, startedAt: createdAt,
      usage: { inputTokens: 10, outputTokens: 10, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
      budget: {
        maxInputTokens: 200_000,
        maxOutputTokens: 5,
        maxCostUsd: 2,
        inputUsdPerMillion: 3,
        outputUsdPerMillion: 15
      },
      steps: [{
        id: 'next',
        state: 'blocked',
        attempt: 1,
        createdAt,
        errorCode: 'workflow_budget_exceeded',
        error: 'Workflow budget exceeded: output tokens 10 >= 5.',
        incomplete: true,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 }
      }],
      failedStepIds: [], blockedStepIds: ['next'], incomplete: true,
      errorCode: 'workflow_step_failed', error: 'Workflow failed at step(s): next'
    };
    const html = renderToStaticMarkup(React.createElement(WorkflowCard, {
      workflow,
      onCancel: async () => undefined,
      onResume: async () => undefined
    }));
    expect(html).toContain('预算');
    expect(html).toContain('↑10/200000');
    expect(html).toContain('↓10/5');
    expect(html).toContain('$0.0002/$2');
    expect(html).toContain('workflow_budget_exceeded');
  });

  it('renders a dependency graph from snapshot dependsOn and structured output', () => {
    const createdAt = '2026-08-16T10:00:00.000Z';
    const emptyUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 };
    const workflow: WorkflowRunSnapshot = {
      id: 'wf_dag', sessionId: 'session', name: 'DAG workflow', state: 'running', revision: 1,
      createdAt, startedAt: createdAt, usage: { inputTokens: 4, outputTokens: 2, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
      steps: [
        {
          id: 'inspect', type: 'agent', profile: 'explore', state: 'completed', attempt: 1, createdAt,
          startedAt: createdAt, finishedAt: '2026-08-16T10:00:04.000Z',
          dependsOn: [], structuredResult: { files: ['a.ts'] }, incomplete: false,
          usage: { inputTokens: 2, outputTokens: 1, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 }
        },
        {
          id: 'kernel', type: 'agent', profile: 'explore', state: 'running', attempt: 1, createdAt,
          startedAt: '2026-08-16T10:00:04.000Z', dependsOn: ['inspect'], incomplete: false, usage: emptyUsage
        },
        {
          id: 'yocto', type: 'agent', profile: 'explore', state: 'completed', attempt: 1, createdAt,
          startedAt: '2026-08-16T10:00:04.000Z', finishedAt: '2026-08-16T10:00:08.000Z',
          dependsOn: ['inspect'], incomplete: false, usage: emptyUsage
        },
        {
          id: 'summary', type: 'agent', profile: 'synthesize', state: 'pending', attempt: 1, createdAt,
          dependsOn: ['kernel', 'yocto'], incomplete: false, usage: emptyUsage
        }
      ],
      failedStepIds: [], blockedStepIds: [], incomplete: false
    };
    const html = renderToStaticMarkup(React.createElement(WorkflowCard, {
      workflow,
      onCancel: async () => undefined,
      onResume: async () => undefined
    }));
    expect(html).toContain('工作流依赖图');
    expect(html).toContain('data-from="inspect" data-to="kernel"');
    expect(html).toContain('data-from="inspect" data-to="yocto"');
    expect(html).toContain('data-from="kernel" data-to="summary"');
    expect(html).toContain('data-from="yocto" data-to="summary"');
    expect(html).toContain('依赖图');
    expect(html).toContain('时间线');
    expect(html).toContain('结构化输出');
    expect(html).toContain('a.ts');
  });
});
