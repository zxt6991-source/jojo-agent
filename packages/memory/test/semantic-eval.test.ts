import { describe, expect, it } from 'vitest';
import { evaluateMemoryRetrieval, type MemoryRetrievalEvalCase } from '../src/index';

describe('semantic retrieval eval', () => {
  it('reports Recall@K, MRR, precision, false positives, and latency', async () => {
    const cases: MemoryRetrievalEvalCase[] = [{
      query: 'node:sqlite', expectedMemoryIds: ['sqlite'], scope: 'global', queryType: 'exact_keyword'
    }, {
      query: '为什么后台不能直接合并', expectedMemoryIds: ['worktree'], scope: 'project', queryType: 'chinese_paraphrase'
    }, {
      query: 'unrelated', expectedMemoryIds: [], scope: 'all', queryType: 'negative'
    }];
    const results: Record<string, string[]> = {
      'node:sqlite': ['sqlite'],
      '为什么后台不能直接合并': ['other', 'worktree'],
      unrelated: []
    };
    const metrics = await evaluateMemoryRetrieval(cases, async (testCase) => results[testCase.query]!, 5);
    expect(metrics).toMatchObject({
      cases: 3,
      recallAtK: 1,
      mrr: 0.75,
      precisionAtK: 0.2,
      noMatchFalsePositiveRate: 0
    });
    expect(metrics.latencyP95Ms).toBeGreaterThanOrEqual(0);
  });
});
