const SECRET_NAME = /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION|OAUTH)(?:_|$)/iu;
const BLOCKED_EXACT = new Set(['NODE_OPTIONS', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']);
const JOJO_SECRET_NAME = /^JOJO_.*(?:CREDENTIAL|AUTH|KEY|TOKEN|SECRET|PASSWORD)/iu;

export function sanitizedHookEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || BLOCKED_EXACT.has(name.toUpperCase()) || SECRET_NAME.test(name) || JOJO_SECRET_NAME.test(name)) continue;
    result[name] = value;
  }
  return result;
}

export function resolveConfiguredEnvironment(
  configured: Record<string, string> | undefined,
  source: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(configured ?? {})) {
    const match = /^\$\{env:([a-zA-Z_][a-zA-Z0-9_]*)\}$/u.exec(value);
    result[name] = match ? source[match[1]!] ?? '' : value;
  }
  return result;
}
