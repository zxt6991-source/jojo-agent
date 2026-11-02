/** One analysis slot shared by the legacy map and all insight perspectives. */
export function createHistoryAnalysisTaskGate() {
  let owner: symbol | undefined;
  return {
    acquire(): (() => void) | undefined {
      if (owner) return undefined;
      const token = Symbol('history-analysis');
      owner = token;
      return () => { if (owner === token) owner = undefined; };
    }
  };
}
export type HistoryAnalysisTaskGate = ReturnType<typeof createHistoryAnalysisTaskGate>;
