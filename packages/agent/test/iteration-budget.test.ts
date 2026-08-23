import { describe, expect, it } from 'vitest';
import {
  createIterationBudgetPolicy,
  extendIterationBudget,
  iterationBudgetInstruction
} from '../src/iteration-budget.js';

describe('dynamic Agent Loop budget', () => {
  it('derives a bounded soft and hard limit from model context capacity', () => {
    expect(createIterationBudgetPolicy({ contextWindowTokens: 32_000, maxOutputTokens: 8_192 })).toEqual({
      dynamic: true,
      currentLimit: 8,
      runLimit: 32,
      absoluteLimit: 128,
      hardLimit: 32,
      extensionStep: 4,
      limitReason: 'max_iterations'
    });
    expect(createIterationBudgetPolicy({ contextWindowTokens: 128_000, maxOutputTokens: 8_192 })).toEqual({
      dynamic: true,
      currentLimit: 14,
      runLimit: 56,
      absoluteLimit: 128,
      hardLimit: 56,
      extensionStep: 7,
      limitReason: 'max_iterations'
    });
  });

  it('extends the soft limit in bounded steps while preserving a hard safety cap', () => {
    let policy = createIterationBudgetPolicy({ contextWindowTokens: 32_000, maxOutputTokens: 8_192 });
    for (let index = 0; index < 10; index += 1) policy = extendIterationBudget(policy);

    expect(policy.currentLimit).toBe(32);
    expect(iterationBudgetInstruction(policy, 30)).toContain('2 tool-capable model iterations');
  });

  it('treats an explicit maxIterations value as a fixed caller limit', () => {
    const policy = createIterationBudgetPolicy({ maxIterations: 5 });

    expect(extendIterationBudget(policy)).toEqual(policy);
    expect(policy).toMatchObject({ dynamic: false, currentLimit: 5, hardLimit: 5 });
  });

  it('caps an untrusted legacy limit at the absolute runtime fuse', () => {
    const policy = createIterationBudgetPolicy({ maxIterations: 999_999 });

    expect(policy).toMatchObject({
      dynamic: false,
      currentLimit: 128,
      runLimit: 128,
      absoluteLimit: 128,
      limitReason: 'absolute_iteration_limit'
    });
  });

  it('supports separate initial and normal run limits', () => {
    const policy = createIterationBudgetPolicy({
      loopBudget: { initialIterations: 6, runMaxIterations: 20, dynamic: true, extensionStep: 5 }
    });

    expect(policy).toMatchObject({ currentLimit: 6, runLimit: 20, absoluteLimit: 128, extensionStep: 5 });
  });
});
