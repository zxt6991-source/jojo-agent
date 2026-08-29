import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type McpDnsResolver = (hostname: string) => Promise<string[]>;
export type McpHttpNetworkGrant = { allowPrivate?: boolean };

const METADATA_HOSTS = new Set(['metadata.google.internal', 'metadata.google', 'instance-data', '169.254.169.254', '100.100.100.200']);

function ipv4Blocked(address: string): 'metadata' | 'private' | undefined {
  const parts = address.split('.').map(Number);
  const [a = -1, b = -1, c = -1, d = -1] = parts;
  if (a === 169 && b === 254 && c === 169 && d === 254) return 'metadata';
  if (a === 100 && b === 100 && c === 100 && d === 200) return 'metadata';
  if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return 'private';
  return undefined;
}

function addressClass(address: string): 'metadata' | 'private' | 'public' {
  if (isIP(address) === 4) return ipv4Blocked(address) ?? 'public';
  const normalized = address.toLowerCase();
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice(7);
    if (isIP(mapped) === 4) return ipv4Blocked(mapped) ?? 'public';
    const [high, low] = mapped.split(':').map((part) => Number.parseInt(part ?? '', 16));
    if (Number.isInteger(high) && Number.isInteger(low)) {
      const ipv4 = `${high! >> 8}.${high! & 0xff}.${low! >> 8}.${low! & 0xff}`;
      return ipv4Blocked(ipv4) ?? 'public';
    }
  }
  if (normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd')
    || /^fe[89ab]/u.test(normalized)) return 'private';
  return 'public';
}

const defaultResolver: McpDnsResolver = async (hostname) => {
  if (isIP(hostname)) return [hostname];
  return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
};

export class McpHttpTargetPolicy {
  constructor(private readonly resolveDns: McpDnsResolver = defaultResolver) {}

  async validate(input: string | URL, grant: McpHttpNetworkGrant = {}): Promise<URL> {
    const url = input instanceof URL ? new URL(input) : new URL(input);
    if (url.username || url.password) throw this.denied('mcp_config_unsafe', 'MCP URL credentials are forbidden.');
    const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']') ? url.hostname.slice(1, -1) : url.hostname;
    const literalLoopback = ['localhost', '127.0.0.1', '::1'].includes(hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && literalLoopback)) {
      throw this.denied('mcp_config_unsafe', 'MCP HTTP targets must use HTTPS; HTTP is limited to loopback.');
    }
    if (METADATA_HOSTS.has(hostname.toLowerCase())) throw this.denied('mcp_private_network_denied', 'Cloud metadata endpoints are permanently blocked.');
    const addresses = await this.resolveDns(hostname);
    if (addresses.length === 0) throw this.denied('mcp_private_network_denied', 'MCP hostname did not resolve.');
    for (const address of addresses) {
      const classification = addressClass(address);
      if (classification === 'metadata') throw this.denied('mcp_private_network_denied', 'Cloud metadata endpoints are permanently blocked.');
      if (classification === 'private' && !literalLoopback && !grant.allowPrivate) {
        throw this.denied('mcp_private_network_denied', `MCP hostname resolved to a private address: ${address}`);
      }
    }
    return url;
  }

  private denied(code: string, message: string): Error {
    return Object.assign(new Error(`${code}: ${message}`), { code });
  }
}

export function createSafeMcpFetch(policy: McpHttpTargetPolicy, grant: McpHttpNetworkGrant = {}, fetchFn: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    let request = new Request(input, { ...init, redirect: 'manual' });
    for (let redirect = 0; redirect <= 5; redirect += 1) {
      await policy.validate(request.url, grant);
      const response = await fetchFn(request.clone(), { redirect: 'manual' });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      if (redirect === 5) throw Object.assign(new Error('mcp_unsafe_redirect: Too many MCP redirects.'), { code: 'mcp_unsafe_redirect' });
      const location = response.headers.get('location');
      if (!location) throw Object.assign(new Error('mcp_unsafe_redirect: Redirect omitted Location.'), { code: 'mcp_unsafe_redirect' });
      const next = await policy.validate(new URL(location, request.url), grant);
      if (![307, 308].includes(response.status) && !['GET', 'HEAD'].includes(request.method)) {
        throw Object.assign(new Error('mcp_unsafe_redirect: Refusing to rewrite an MCP request method.'), { code: 'mcp_unsafe_redirect' });
      }
      const redirected = new Request(next, request);
      if (next.origin !== new URL(request.url).origin) {
        for (const name of ['authorization', 'cookie', 'proxy-authorization', 'x-api-key', 'x-auth-token']) {
          redirected.headers.delete(name);
        }
      }
      request = redirected;
    }
    throw Object.assign(new Error('mcp_unsafe_redirect'), { code: 'mcp_unsafe_redirect' });
  };
}
