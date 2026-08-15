import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
blocked.addSubnet('169.254.0.0', 16, 'ipv4');
blocked.addSubnet('224.0.0.0', 4, 'ipv4');
blocked.addAddress('0.0.0.0', 'ipv4');
blocked.addAddress('255.255.255.255', 'ipv4');
blocked.addSubnet('fe80::', 10, 'ipv6');
blocked.addSubnet('ff00::', 8, 'ipv6');
blocked.addAddress('::', 'ipv6');
blocked.addAddress('fd00:ec2::254', 'ipv6');

const METADATA_HOSTS = new Set(['metadata.google.internal', 'metadata.google.com']);

export class UnsafeWebUrlError extends Error {
  readonly code = 'unsafe_url';
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeWebUrlError';
  }
}

export function isBlockedFetchAddress(ip: string): boolean {
  const mapped = ipv4MappedAddress(ip);
  if (mapped) return isBlockedFetchAddress(mapped);
  if (isIP(ip) === 4) return blocked.check(ip, 'ipv4');
  if (isIP(ip) === 6) return blocked.check(ip, 'ipv6');
  return false;
}

export function parseHttpUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new UnsafeWebUrlError('URL is invalid.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeWebUrlError('Only HTTP and HTTPS URLs are allowed.');
  }
  if (url.username || url.password) {
    throw new UnsafeWebUrlError('URLs must not contain embedded credentials.');
  }
  if (!url.hostname) throw new UnsafeWebUrlError('URL is missing a host.');
  return url;
}

export async function assertSafeHttpUrl(value: string): Promise<URL> {
  const url = parseHttpUrl(value);
  const hostname = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  if (METADATA_HOSTS.has(hostname) || hostname.endsWith('.metadata.google.internal')) {
    throw new UnsafeWebUrlError(`Refusing to fetch metadata host ${hostname}.`);
  }
  if (isIP(hostname)) {
    if (isBlockedFetchAddress(hostname)) {
      throw new UnsafeWebUrlError(`Refusing to connect to link-local or metadata address ${hostname}.`);
    }
    return url;
  }
  let records: Array<{ address: string }>;
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new UnsafeWebUrlError(`Could not resolve host ${hostname}.`);
  }
  if (!records.length) throw new UnsafeWebUrlError(`Could not resolve host ${hostname}.`);
  const blockedAddress = records.find((record) => isBlockedFetchAddress(record.address));
  if (blockedAddress) {
    throw new UnsafeWebUrlError(`Refusing to connect to link-local or metadata address ${blockedAddress.address}.`);
  }
  return url;
}

function ipv4MappedAddress(ip: string): string | undefined {
  const lower = ip.toLowerCase();
  if (lower.startsWith('::ffff:')) return lower.slice('::ffff:'.length);
  return undefined;
}
