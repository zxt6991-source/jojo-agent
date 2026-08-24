export type MemoryRetrievalEvalCase = {
  query: string;
  expectedMemoryIds: string[];
  scope: 'global' | 'project' | 'all';
  queryType: 'exact_keyword' | 'semantic_paraphrase' | 'chinese_paraphrase' | 'path_error_code' | 'old_decision' | 'user_preference' | 'negative';
};

export type MemoryRetrievalEvalResult = {
  cases: number;
  recallAtK: number;
  mrr: number;
  precisionAtK: number;
  noMatchFalsePositiveRate: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
};

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}

export async function evaluateMemoryRetrieval(
  cases: MemoryRetrievalEvalCase[],
  search: (testCase: MemoryRetrievalEvalCase) => Promise<string[]>,
  k = 5
): Promise<MemoryRetrievalEvalResult> {
  let recalled = 0;
  let expected = 0;
  let reciprocalRank = 0;
  let relevantReturned = 0;
  let returnedSlots = 0;
  let negativeCases = 0;
  let falsePositiveNegatives = 0;
  const latencies: number[] = [];
  for (const testCase of cases) {
    const startedAt = performance.now();
    const ids = (await search(testCase)).slice(0, k);
    latencies.push(performance.now() - startedAt);
    const expectedIds = new Set(testCase.expectedMemoryIds);
    if (!expectedIds.size) {
      negativeCases += 1;
      if (ids.length) falsePositiveNegatives += 1;
      continue;
    }
    expected += expectedIds.size;
    const relevant = ids.filter((id) => expectedIds.has(id));
    recalled += new Set(relevant).size;
    relevantReturned += relevant.length;
    returnedSlots += k;
    const first = ids.findIndex((id) => expectedIds.has(id));
    if (first >= 0) reciprocalRank += 1 / (first + 1);
  }
  const positiveCases = cases.length - negativeCases;
  return {
    cases: cases.length,
    recallAtK: expected ? recalled / expected : 1,
    mrr: positiveCases ? reciprocalRank / positiveCases : 1,
    precisionAtK: returnedSlots ? relevantReturned / returnedSlots : 1,
    noMatchFalsePositiveRate: negativeCases ? falsePositiveNegatives / negativeCases : 0,
    latencyP50Ms: percentile(latencies, 0.5),
    latencyP95Ms: percentile(latencies, 0.95)
  };
}
