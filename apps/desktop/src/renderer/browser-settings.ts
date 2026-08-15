const BROWSER_DOMAIN_PATTERN = /^(?:\*\.)?[a-z0-9.-]+$/iu;

export function parseBrowserDomainList(value: string): string[] {
  const seen = new Set<string>();
  const domains: string[] = [];
  for (const line of value.split(/[\r\n,;\s]+/u)) {
    const domain = line.trim().toLowerCase().replace(/\.$/u, '');
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    domains.push(domain);
  }
  return domains;
}

export function browserDomainIssue(value: string): string | null {
  const domain = value.trim().toLowerCase();
  if (!domain) return '请输入域名。';
  if (/^https?:\/\//u.test(domain) || domain.includes('/')) return '只需填写主机名，例如 example.com 或 *.example.com。';
  if (domain.length > 253) return '域名过长。';
  if (!BROWSER_DOMAIN_PATTERN.test(domain)) return '域名格式无效。可使用 example.com 或 *.example.com。';
  return null;
}
