import { describe, expect, it, vi } from 'vitest';
import { WorkflowDefinitionSchema, type WorkflowDefinition, type WorkflowRunSnapshot } from '@desktop-agent/contracts';
import {
  AgentExecutionScheduler,
  type LeafAgentRunner,
  type WorkflowRecordingInvocation,
  type WorkflowRecordingInvocationResult,
  type WorkflowRecordingRuntime,
  WorkflowEngine
} from '../src/index.js';

const runner: LeafAgentRunner = {
  run: vi.fn(async () => ({
    result: 'unused',
    stopReason: 'stop',
    usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
    incomplete: false
  }))
};

function request(definition: WorkflowDefinition, browserApproved = true) {
  return {
    id: 'wf_browser',
    sessionId: 'session',
    workingDirectory: process.cwd(),
    providerId: 'provider',
    model: 'model',
    args: { query: 'quarterly' },
    browserApproved,
    definition,
    createdAt: new Date().toISOString()
  };
}

function callbacks(logs: string[] = []) {
  return {
    onChanged: (_snapshot: WorkflowRunSnapshot) => undefined,
    onLog: (event: { message: string }) => logs.push(event.message)
  };
}

function browserWorkflow(step: Record<string, unknown>): WorkflowDefinition {
  return WorkflowDefinitionSchema.parse({
    schemaVersion: 1,
    name: 'browser workflow',
    outputStepId: 'replay',
    steps: [{ id: 'replay', type: 'recording', recording: 'export-report', ...step }]
  });
}

describe('WorkflowEngine browser steps', () => {
  it('binds workflow params and exposes structured replay outputs to downstream steps', async () => {
    const invocations: WorkflowRecordingInvocation[] = [];
    const recordingRuntime: WorkflowRecordingRuntime = {
      execute: async (invocation) => {
        invocations.push(invocation);
        invocation.onProgress(`Replay progress for ${invocation.recordingId}`);
        if (invocation.recordingId === 'export-report') {
          return {
            ok: true,
            content: 'exported',
            structuredResult: {
              runId: invocation.runId,
              outputs: { report: { type: 'file', path: '/workspace/report.xlsx' } }
            }
          };
        }
        return { ok: true, content: `uploaded ${String(invocation.params.file)}` };
      }
    };
    const workflow = WorkflowDefinitionSchema.parse({
      schemaVersion: 1,
      name: 'browser binding',
      outputStepId: 'upload',
      steps: [
        {
          id: 'export', type: 'recording', recording: 'export-report',
          params: { format: 'xlsx' },
          inputs: { query: { valueFrom: '$workflow.args.query' } }
        },
        {
          id: 'upload', type: 'recording', recording: 'upload-report', dependsOn: ['export'],
          inputs: { file: { valueFrom: '$steps.export.outputs.report.path' } }
        }
      ]
    });

    const logs: string[] = [];
    const final = await new WorkflowEngine(runner, new AgentExecutionScheduler(1), { recordingRuntime })
      .run(request(workflow), new AbortController().signal, callbacks(logs));

    expect(invocations.map(({ recordingId, params, resume }) => ({ recordingId, params, resume }))).toEqual([
      { recordingId: 'export-report', params: { format: 'xlsx', query: 'quarterly' }, resume: false },
      { recordingId: 'upload-report', params: { file: '/workspace/report.xlsx' }, resume: false }
    ]);
    expect(invocations[0]!.runId).toMatch(/^brun_[a-f0-9]{32}$/u);
    expect(final).toMatchObject({ state: 'completed', result: 'uploaded /workspace/report.xlsx' });
    expect(final.steps[0]).toMatchObject({
      type: 'recording', recording: 'export-report', state: 'completed', schemaValid: true,
      structuredResult: { outputs: { report: { path: '/workspace/report.xlsx' } } }
    });
    expect(logs).toEqual(expect.arrayContaining([
      expect.stringMatching(/Started workflow recording .* step/u),
      'Replay progress for export-report',
      'Replay progress for upload-report'
    ]));
  });

  it('requires workflow-start approval before invoking the browser runtime', async () => {
    const recordingRuntime: WorkflowRecordingRuntime = { execute: vi.fn() };
    const final = await new WorkflowEngine(runner, new AgentExecutionScheduler(1), { recordingRuntime })
      .run(request(browserWorkflow({}), false), new AbortController().signal, callbacks());

    expect(recordingRuntime.execute).not.toHaveBeenCalled();
    expect(final.steps[0]).toMatchObject({ state: 'failed', errorCode: 'permission_denied' });
  });

  it('retries a failed replay with the same journal run id in resume mode', async () => {
    const invocations: WorkflowRecordingInvocation[] = [];
    const results: WorkflowRecordingInvocationResult[] = [
      { ok: false, code: 'browser_replay_failed', content: 'transient target failure' },
      { ok: true, content: 'recovered', structuredResult: { success: true } }
    ];
    const recordingRuntime: WorkflowRecordingRuntime = {
      execute: async (invocation) => {
        invocations.push(invocation);
        return results.shift()!;
      }
    };
    const workflow = browserWorkflow({
      retry: { maxAttempts: 2, backoffMs: 0, retryOn: ['browser_replay_failed'] }
    });

    const final = await new WorkflowEngine(runner, new AgentExecutionScheduler(1), { recordingRuntime })
      .run(request(workflow), new AbortController().signal, callbacks());

    expect(invocations).toHaveLength(2);
    expect(invocations.map(({ runId, resume }) => ({ runId, resume }))).toEqual([
      { runId: invocations[0]!.runId, resume: false },
      { runId: invocations[0]!.runId, resume: true }
    ]);
    expect(final.steps[0]).toMatchObject({ state: 'completed', attempt: 2, output: 'recovered' });
  });

  it('does not automatically retry an unsafe external-effect resume', async () => {
    const recordingRuntime: WorkflowRecordingRuntime = {
      execute: vi.fn(async () => ({
        ok: false,
        code: 'browser_resume_unsafe',
        content: 'Confirm the external effect before retrying it.'
      }))
    };
    const workflow = browserWorkflow({
      retry: { maxAttempts: 3, backoffMs: 0, retryOn: ['browser_replay_failed'] }
    });

    const final = await new WorkflowEngine(runner, new AgentExecutionScheduler(1), { recordingRuntime })
      .run(request(workflow), new AbortController().signal, callbacks());

    expect(recordingRuntime.execute).toHaveBeenCalledTimes(1);
    expect(final.steps[0]).toMatchObject({ state: 'failed', attempt: 1, errorCode: 'browser_resume_unsafe' });
  });

  it('does not retry an untrusted project recording', async () => {
    const recordingRuntime: WorkflowRecordingRuntime = {
      execute: vi.fn(async () => ({
        ok: false,
        code: 'permission_denied',
        content: 'Trust this project recording before replaying it.'
      }))
    };
    const workflow = browserWorkflow({
      retry: { maxAttempts: 3, backoffMs: 0, retryOn: ['browser_replay_failed'] }
    });

    const final = await new WorkflowEngine(runner, new AgentExecutionScheduler(1), { recordingRuntime })
      .run(request(workflow), new AbortController().signal, callbacks());

    expect(recordingRuntime.execute).toHaveBeenCalledTimes(1);
    expect(final.steps[0]).toMatchObject({ state: 'failed', attempt: 1, errorCode: 'permission_denied' });
  });
});
