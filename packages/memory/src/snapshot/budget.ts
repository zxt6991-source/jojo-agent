export function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

export function snapshotTokenBudget(contextWindowTokens: number, configuredMax = 4096, ratio = 0.05): number {
  return Math.max(0, Math.floor(Math.min(4096, configuredMax, contextWindowTokens * ratio)));
}

export function truncateToTokens(content: string, tokens: number): string {
  if (tokens <= 0) return '';
  const characters = tokens * 4;
  return content.length <= characters ? content : `${content.slice(0, Math.max(0, characters - 16)).trimEnd()}\n[truncated]`;
}
