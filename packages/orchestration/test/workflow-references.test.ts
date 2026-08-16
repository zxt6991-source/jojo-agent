import { describe, expect, it } from 'vitest';
import type { WorkflowStepSnapshot } from '@desktop-agent/contracts';
import {
  emptyUsage,
  MAX_RESOLVED_WORKFLOW_INPUT_BYTES,
  resolveWorkflowReference,
  resolveWorkflowStepInputs
} from '../src/index.js';

function dependency(): WorkflowStepSnapshot {
  return {
    id: 'source', state: 'completed', attempt: 1, createdAt: new Date().toISOString(),
    output: 'raw output', structuredResult: { files: ['a.ts', 'b.ts'], nested: { count: 2 } },
    schemaValid: true, incomplete: false, usage: emptyUsage()
  };
}

describe('workflow input references', () => {
  it('resolves workflow args, raw outputs, object paths, and array indexes', () => {
    const dependencies = [dependency()];
    expect(resolveWorkflowReference('$workflow.args.target', dependencies, { target: 'src' })).toBe('src');
    expect(resolveWorkflowReference('$steps.source.output', dependencies, {})).toBe('raw output');
    expect(resolveWorkflowReference('$steps.source.structuredResult.nested.count', dependencies, {})).toBe(2);
    expect(resolveWorkflowReference('$steps.source.structuredResult.files.1', dependencies, {})).toBe('b.ts');
  });

  it('returns stable errors for invalid and missing references', () => {
    expect(() => resolveWorkflowReference('$bad.reference', [dependency()], {}))
      .toThrowError(expect.objectContaining({ code: 'workflow_reference_invalid' }));
    expect(() => resolveWorkflowReference('$workflow.args.missing', [dependency()], {}))
      .toThrowError(expect.objectContaining({ code: 'workflow_reference_not_found' }));
    expect(() => resolveWorkflowReference('$steps.source.output.path', [dependency()], {}))
      .toThrowError(expect.objectContaining({ code: 'workflow_reference_invalid' }));
  });

  it('enforces the total resolved input size limit', () => {
    const step = {
      id: 'summary', type: 'agent' as const, profile: 'explore', task: 'Summary', dependsOn: ['source'],
      continueOnError: false, inputs: { content: { valueFrom: '$steps.source.output' } }
    };
    const source = dependency();
    source.output = 'x'.repeat(MAX_RESOLVED_WORKFLOW_INPUT_BYTES + 1);
    expect(() => resolveWorkflowStepInputs(step, [source], {}))
      .toThrowError(expect.objectContaining({ code: 'workflow_reference_invalid' }));
  });
});
