export type CycleDetection = { period: number; repeats: number };

export function detectRepeatedCycle(
  fingerprints: readonly string[],
  maxPeriod = 3,
  requiredRepeats = 3
): CycleDetection | null {
  if (requiredRepeats < 2) return null;
  for (let period = 1; period <= maxPeriod; period += 1) {
    const needed = period * requiredRepeats;
    if (fingerprints.length < needed) continue;
    const tail = fingerprints.slice(-needed);
    let matches = true;
    for (let index = period; index < tail.length; index += 1) {
      if (tail[index] !== tail[index % period]) {
        matches = false;
        break;
      }
    }
    if (matches) return { period, repeats: requiredRepeats };
  }
  return null;
}

export function recordIterationFingerprint(
  recent: readonly string[],
  fingerprint: string | null,
  windowSize: number
): string[] {
  if (!fingerprint) return [...recent];
  return [...recent, fingerprint].slice(-Math.max(1, windowSize));
}
