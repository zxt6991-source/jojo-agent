export function deepMerge<T>(...values: unknown[]): T {
  let result: unknown = {};
  for (const value of values) result = mergePair(result, value);
  return result as T;
}

function mergePair(left: unknown, right: unknown): unknown {
  if (!isRecord(right)) return right === undefined ? left : right;
  if (isSecretRecord(right) || isSecretRecord(left)) return { ...right };
  const output: Record<string, unknown> = isRecord(left) ? { ...left } : {};
  for (const [key, value] of Object.entries(right)) {
    if (value === undefined) continue;
    output[key] = isRecord(value) ? mergePair(output[key], value) : value;
  }
  return output;
}

function isSecretRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && ('env' in value || 'literal' in value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
