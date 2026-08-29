import { describe, expect, it, vi } from 'vitest';
import { McpServerConfigSchema, type SecretBroker } from '@desktop-agent/contracts';
import {
  createSafeMcpFetch,
  EnvironmentSecretBroker,
  McpHttpTargetPolicy,
  resolveMcpConfigValues
} from '../src/index.js';

describe('MCP HTTP target security', () => {
  it('allows public HTTPS and literal loopback HTTP, but rejects public HTTP and URL credentials', async () => {
    const policy = new McpHttpTargetPolicy(async (hostname) => hostname === 'localhost'
      ? ['127.0.0.1']
      : ['93.184.216.34']);

    await expect(policy.validate('https://example.com/mcp')).resolves.toMatchObject({ protocol: 'https:' });
    await expect(policy.validate('http://localhost:3000/mcp')).resolves.toMatchObject({ hostname: 'localhost' });
    await expect(policy.validate('http://example.com/mcp')).rejects.toMatchObject({ code: 'mcp_config_unsafe' });
    await expect(policy.validate('https://user:secret@example.com/mcp')).rejects.toMatchObject({ code: 'mcp_config_unsafe' });
  });

  it('blocks private DNS answers unless granted and permanently blocks metadata targets', async () => {
    const policy = new McpHttpTargetPolicy(async (hostname) => {
      if (hostname === 'private.example') return ['10.0.0.8'];
      if (hostname === 'mixed.example') return ['93.184.216.34', '192.168.1.8'];
      return ['93.184.216.34'];
    });

    await expect(policy.validate('https://private.example/mcp')).rejects.toMatchObject({ code: 'mcp_private_network_denied' });
    await expect(policy.validate('https://mixed.example/mcp')).rejects.toMatchObject({ code: 'mcp_private_network_denied' });
    await expect(policy.validate('https://private.example/mcp', { allowPrivate: true })).resolves.toMatchObject({ hostname: 'private.example' });
    await expect(policy.validate('https://169.254.169.254/latest/meta-data', { allowPrivate: true }))
      .rejects.toMatchObject({ code: 'mcp_private_network_denied' });
    await expect(policy.validate('https://metadata.google.internal/computeMetadata/v1', { allowPrivate: true }))
      .rejects.toMatchObject({ code: 'mcp_private_network_denied' });
  });

  it('blocks IPv4-mapped IPv6 loopback answers', async () => {
    const policy = new McpHttpTargetPolicy(async () => ['::ffff:7f00:1']);
    await expect(policy.validate('https://mapped.example/mcp')).rejects.toMatchObject({ code: 'mcp_private_network_denied' });
  });

  it('validates every redirect before issuing the next request', async () => {
    const policy = new McpHttpTargetPolicy(async (hostname) => hostname === 'private.example'
      ? ['192.168.0.10']
      : ['93.184.216.34']);
    const fetchFn = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'https://private.example/mcp' }
    })) as unknown as typeof fetch;
    const safeFetch = createSafeMcpFetch(policy, {}, fetchFn);

    await expect(safeFetch('https://public.example/mcp')).rejects.toMatchObject({ code: 'mcp_private_network_denied' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('does not downgrade non-idempotent requests across rewriting redirects', async () => {
    const policy = new McpHttpTargetPolicy(async () => ['93.184.216.34']);
    const fetchFn = vi.fn(async () => new Response(null, {
      status: 303,
      headers: { location: 'https://other.example/mcp' }
    })) as unknown as typeof fetch;

    await expect(createSafeMcpFetch(policy, {}, fetchFn)('https://public.example/mcp', {
      method: 'POST', body: '{}'
    })).rejects.toMatchObject({ code: 'mcp_unsafe_redirect' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('strips secret headers when a redirect changes origin', async () => {
    const policy = new McpHttpTargetPolicy(async () => ['93.184.216.34']);
    const seen: Request[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      seen.push(request);
      return seen.length === 1
        ? new Response(null, { status: 307, headers: { location: 'https://other.example/mcp' } })
        : new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    await expect(createSafeMcpFetch(policy, {}, fetchFn)('https://public.example/mcp', {
      headers: { Authorization: 'Bearer runtime-secret', 'X-Client': 'desktop-agent' }
    })).resolves.toMatchObject({ status: 200 });
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer runtime-secret');
    expect(seen[1]?.headers.get('authorization')).toBeNull();
    expect(seen[1]?.headers.get('x-client')).toBe('desktop-agent');
  });
});

describe('MCP secret references', () => {
  it('rejects literal sensitive settings and accepts secret references', () => {
    expect(McpServerConfigSchema.safeParse({
      id: 'literal-header', name: 'Literal header', transport: 'streamable_http', url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer visible-secret' }
    }).success).toBe(false);
    expect(McpServerConfigSchema.safeParse({
      id: 'literal-env', name: 'Literal env', transport: 'stdio', command: 'server',
      env: { API_TOKEN: { value: 'visible-secret' } }
    }).success).toBe(false);
    expect(McpServerConfigSchema.safeParse({
      id: 'reference', name: 'Reference', transport: 'streamable_http', url: 'https://example.com/mcp',
      headers: { Authorization: { secretRef: { provider: 'env', key: 'MCP_AUTHORIZATION' } } }
    }).success).toBe(true);
  });

  it('resolves environment references at connection time and disposes leases', async () => {
    const broker = new EnvironmentSecretBroker({ MCP_AUTHORIZATION: 'Bearer runtime-secret' });
    const resolved = await resolveMcpConfigValues({
      Authorization: { secretRef: { provider: 'env', key: 'MCP_AUTHORIZATION' } },
      'X-Client': { value: 'desktop-agent' }
    }, broker, 'test connection', (name) => name.toLowerCase() === 'authorization');

    expect(resolved.values).toEqual({ Authorization: 'Bearer runtime-secret', 'X-Client': 'desktop-agent' });
    resolved.dispose();
  });

  it('disposes earlier leases if a later reference cannot be resolved', async () => {
    const dispose = vi.fn();
    const broker: SecretBroker = {
      resolve: vi.fn(async (reference) => {
        if (reference.key === 'missing') throw new Error('missing');
        return { value: 'resolved', dispose };
      })
    };

    await expect(resolveMcpConfigValues({
      First: { secretRef: { provider: 'env', key: 'present' } },
      Second: { secretRef: { provider: 'env', key: 'missing' } }
    }, broker, 'test connection', () => false)).rejects.toThrow('missing');
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
