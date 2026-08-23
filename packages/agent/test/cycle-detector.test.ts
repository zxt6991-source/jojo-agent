import { describe, expect, it } from 'vitest';
import { detectRepeatedCycle, recordIterationFingerprint } from '../src/index.js';

describe('tool batch cycle detector', () => {
  it.each([
    { values: ['A', 'A', 'A'], period: 1 },
    { values: ['A', 'B', 'A', 'B', 'A', 'B'], period: 2 },
    { values: ['A', 'B', 'C', 'A', 'B', 'C', 'A', 'B', 'C'], period: 3 }
  ])('detects a period-$period cycle', ({ values, period }) => {
    expect(detectRepeatedCycle(values, 3, 3)).toEqual({ period, repeats: 3 });
  });

  it('does not flag an incomplete cycle', () => {
    expect(detectRepeatedCycle(['A', 'B', 'A', 'B'], 3, 3)).toBeNull();
  });

  it('retains only the configured recent window', () => {
    expect(recordIterationFingerprint(['A', 'B', 'C'], 'D', 3)).toEqual(['B', 'C', 'D']);
  });
});
