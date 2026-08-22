const INJECTION_PATTERNS = [
  /ignore (?:all|any|the) previous instructions/iu,
  /(?:system|developer) message\s*:/iu,
  /bypass (?:the )?(?:permission|safety|policy)/iu,
  /automatically approve/iu
];

export function sanitizeMemoryContent(content: string): { content: string; suspicious: boolean } {
  const normalized = content.split(String.fromCharCode(0)).join('').trim();
  return {
    content: normalized,
    suspicious: INJECTION_PATTERNS.some((pattern) => pattern.test(normalized))
  };
}
