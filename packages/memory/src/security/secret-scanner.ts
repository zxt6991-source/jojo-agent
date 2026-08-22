export type SecretFinding = {
  kind: string;
  severity: 'deny' | 'warning';
  line: number;
};

const DENY_PATTERNS: Array<[string, RegExp]> = [
  ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u],
  ['authorization_header', /^\s*authorization\s*:\s*(?:bearer|basic)\s+\S+/imu],
  ['cookie_header', /^\s*(?:set-)?cookie\s*:\s*\S+/imu],
  ['api_key', /\b(?:sk-(?:proj-)?|gh[pousr]_|xox[baprs]-|AKIA)[A-Za-z0-9_-]{12,}\b/u],
  ['token_assignment', /^\s*(?:[A-Z0-9_]*(?:TOKEN|API_KEY|SECRET|PASSWORD)[A-Z0-9_]*)\s*=\s*[^\s#]{8,}\s*$/imu]
];

function lineOf(content: string, offset: number): number {
  return content.slice(0, offset).split('\n').length;
}

export function scanSecrets(content: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const [kind, pattern] of DENY_PATTERNS) {
    const match = pattern.exec(content);
    if (match?.index !== undefined) findings.push({ kind, severity: 'deny', line: lineOf(content, match.index) });
  }
  const entropyLike = /\b[A-Za-z0-9+/=_-]{40,}\b/gu;
  for (const match of content.matchAll(entropyLike)) {
    const value = match[0];
    if (!/[a-z]/u.test(value) || !/[A-Z]/u.test(value) || !/[0-9]/u.test(value)) continue;
    findings.push({ kind: 'high_entropy_string', severity: 'warning', line: lineOf(content, match.index ?? 0) });
  }
  return findings;
}
