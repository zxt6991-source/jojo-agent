import { describe, expect, it, vi } from 'vitest';
import type {
  ContextContributionRequest,
  ExtensionAPI,
  ExtensionManifest,
  Tool
} from '@desktop-agent/contracts';
import { HookRegistry } from '@desktop-agent/hooks';
import { AgentProfileRegistry } from '@desktop-agent/orchestration';
import { ProviderRegistry } from '@desktop-agent/providers';
import {
  ContextContributionRegistry,
  ExtensionHost,
  McpContributionAdapter,
  McpManager,
  MemoryExtensionStorageBackend,
  NamespacedExtensionStorage,
  SkillContributionAdapter,
  ToolContributionRegistry
} from '../src/index.js';

const tool: Tool = {
  definition: { name: 'ignored', description: 'test tool', inputSchema: { type: 'object' } },
  async execute() { return { callId: '', ok: true, content: 'ok' }; }
};

function request(overrides: Partial<ContextContributionRequest> = {}): ContextContributionRequest {
  return {
    sessionId: 'session-1',
    laneId: 'main',
    runId: 'run-1',
    workingDirectory: '/workspace',
    signal: new AbortController().signal,
    ...overrides
  };
}

describe('ExtensionHost', () => {
  it('routes builtin contributions and removes them on deactivation', async () => {
    const hooks = new HookRegistry();
    const tools = new ToolContributionRegistry();
    const contexts = new ContextContributionRegistry();
    const host = new ExtensionHost({ hooks, tools, contexts });
    const handle = await host.activate({
      owner: { id: 'browser', version: '1.0.0', source: 'builtin' },
      capabilities: ['tool', 'hook', 'context'],
      permissions: ['runtime.observe'],
      activate(api) {
        api.registerTool({ id: 'browser_open', tool });
        api.registerHook('Stop', () => undefined, { id: 'cleanup' });
        api.registerContextContributor({
          id: 'current-page',
          async contribute() {
            return { blocks: [{ id: 'page', kind: 'environment', content: 'example.test', priority: 10, source: 'spoofed' }] };
          }
        });
      }
    });

    expect(handle.state).toBe('running');
    expect(tools.resolve().map((entry) => entry.definition.name)).toEqual(['browser_open']);
    expect(hooks.snapshot('Stop')).toMatchObject([{ id: 'browser:cleanup', source: 'builtin' }]);
    await expect(contexts.build(request())).resolves.toMatchObject({
      blocks: [{ id: 'page', source: 'browser', content: 'example.test' }]
    });
    expect(host.snapshot()).toMatchObject({
      toolCatalogVersion: 1,
      hookRegistryVersion: 1,
      contextRegistryVersion: 1,
      extensions: [{ id: 'browser', version: '1.0.0' }]
    });

    await handle.dispose();
    expect(handle.state).toBe('disposed');
    expect(tools.resolve()).toEqual([]);
    expect(hooks.snapshot('Stop')).toEqual([]);
    expect((await contexts.build(request())).blocks).toEqual([]);
  });

  it('requires trust and host grants for external code and namespaces tools', async () => {
    const manifest: ExtensionManifest = {
      id: 'com.acme.jira',
      name: 'Jira',
      version: '2.0.0',
      apiVersion: '1',
      capabilities: ['tool', 'hook'],
      permissions: ['network']
    };
    const activate = vi.fn((api: ExtensionAPI) => {
      api.registerTool({ id: 'create_issue', tool });
    });
    const definition = {
      owner: { id: 'com.acme.jira', version: '2.0.0', source: 'external' as const },
      manifest,
      activate
    };
    const host = new ExtensionHost();

    await expect(host.activate(definition)).rejects.toThrow('extension_not_trusted');
    await host.activate(definition, { trusted: true, capabilities: ['tool'], permissions: ['network'] });
    expect(host.tools.resolve()[0]?.definition.name).toBe('com.acme.jira:create_issue');
    expect(host.tools.snapshot()[0]).toMatchObject({
      owner: { id: 'com.acme.jira', source: 'external' },
      permissions: ['network']
    });
  });

  it('does not let a manifest declaration grant hook approval authority', async () => {
    const hooks = new HookRegistry();
    const host = new ExtensionHost({ hooks });
    const manifest: ExtensionManifest = {
      id: 'com.acme.guard', name: 'Guard', version: '1.0.0', apiVersion: '1', capabilities: ['hook']
    };

    await expect(host.activate({
      owner: { id: manifest.id, version: manifest.version, source: 'external' },
      manifest,
      activate(api) {
        api.registerHook('PreToolUse', () => ({ decision: 'approve' }), { id: 'approve', canApprove: true });
      }
    }, { trusted: true, capabilities: ['hook'] })).rejects.toThrow('extension_hook_approval_not_granted');

    await host.activate({
      owner: { id: manifest.id, version: manifest.version, source: 'external' },
      manifest,
      activate(api) {
        api.registerHook('PreToolUse', () => ({ decision: 'approve' }), { id: 'approve', canApprove: true });
      }
    }, { trusted: true, capabilities: ['hook'], canApproveHooks: true });
    expect(hooks.snapshot('PreToolUse')[0]).toMatchObject({ source: 'extension', canApprove: true });
  });

  it('rolls back partial registrations when activation fails', async () => {
    const host = new ExtensionHost();
    await expect(host.activate({
      owner: { id: 'broken', version: '1', source: 'builtin' },
      capabilities: ['tool'],
      activate(api) {
        api.registerTool({ id: 'temporary', tool });
        throw new Error('activation failed');
      }
    })).rejects.toThrow('activation failed');
    expect(host.tools.resolve()).toEqual([]);
    expect(host.state('broken')).toBeUndefined();
  });

  it('adapts preview provider and profile contributions to existing registries', async () => {
    const providers = new ProviderRegistry();
    const profiles = new AgentProfileRegistry();
    const host = new ExtensionHost({ providers, agentProfiles: profiles });
    const handle = await host.activate({
      owner: { id: 'preview', version: '1', source: 'builtin' },
      capabilities: ['provider', 'agent_profile'],
      activate(api) {
        api.registerProvider({
          id: 'test-provider',
          capabilities: { toolCalls: true },
          create: () => ({ async *stream() { yield { type: 'response_completed' as const, stopReason: 'stop' }; } })
        });
        api.registerAgentProfile({
          id: 'reviewer', description: 'Review code.', systemPrompt: 'Review.', readOnly: true
        });
      }
    });

    expect(providers.has('test-provider')).toBe(true);
    expect(profiles.get('reviewer')).toMatchObject({ source: 'builtin', readOnly: true });
    await handle.dispose();
    expect(providers.has('test-provider')).toBe(false);
    expect(() => profiles.get('reviewer')).toThrow('Unknown agent profile');
  });
});

describe('ContextContributionRegistry', () => {
  it('applies priority budgets, ownership, trace, and scope-aware caching', async () => {
    const registry = new ContextContributionRegistry();
    const contribute = vi.fn(async () => ({
      blocks: [
        { id: 'large', kind: 'resource' as const, content: '123456', priority: 1, source: 'ignored', cachePolicy: 'session' as const },
        { id: 'policy', kind: 'instruction' as const, content: 'must', priority: 100, source: 'ignored', cachePolicy: 'session' as const }
      ]
    }));
    registry.register({ id: 'policy', version: '1', source: 'builtin' }, { id: 'rules', contribute });

    const first = await registry.build(request(), { maxCharacters: 5 });
    expect(first.blocks).toEqual([{ id: 'policy', kind: 'instruction', content: 'must', priority: 100, source: 'policy', cachePolicy: 'session' }]);
    expect(first.truncated).toBe(true);
    expect(first.trace[0]).toMatchObject({ status: 'contributed', blockCount: 2 });

    const second = await registry.build(request({ runId: 'run-2' }));
    expect(second.trace[0]).toMatchObject({ status: 'cached' });
    expect(contribute).toHaveBeenCalledTimes(1);
    registry.clearSession('session-1');
    await registry.build(request({ runId: 'run-3' }));
    expect(contribute).toHaveBeenCalledTimes(2);
  });
});

describe('first-party contribution adapters', () => {
  it('routes MCP tools and server instructions through the shared registries', async () => {
    const manager = new McpManager(() => undefined, async () => ({
      listTools: async () => ({ tools: [{ name: 'lookup', description: 'Look up data', inputSchema: { type: 'object' } }] }),
      callTool: async () => ({ content: [{ type: 'text', text: 'done' }] }),
      close: async () => undefined,
      instructions: 'Respect the remote service policy.'
    }));
    await manager.configure([{
      id: 'demo', name: 'Demo', enabled: true, transport: 'stdio', command: 'demo', args: []
    }]);
    const tools = new ToolContributionRegistry();
    const contexts = new ContextContributionRegistry();
    const adapter = new McpContributionAdapter(manager, tools, contexts);
    adapter.syncTools();

    expect(tools.resolve().map((entry) => entry.definition.name)).toEqual(['mcp__demo__lookup']);
    await expect(contexts.build(request())).resolves.toMatchObject({
      blocks: [{ source: 'mcp', content: expect.stringContaining('remote service policy') }]
    });
    adapter.dispose();
    expect(tools.resolve()).toEqual([]);
  });

  it('routes Skill catalog context and tools without treating Skills as code extensions', async () => {
    const tools = new ToolContributionRegistry();
    const contexts = new ContextContributionRegistry();
    const adapter = new SkillContributionAdapter(tools, contexts);
    adapter.sync([{
      id: 'review', name: 'review', description: 'Review code.', content: '# Review', enabled: true,
      path: '/skills/review/SKILL.md', rootPath: '/skills/review', origin: 'user',
      resources: { scripts: [], templates: [], references: [] }
    }]);

    expect(tools.resolve().map((entry) => entry.definition.name)).toEqual(['load_skill']);
    await expect(contexts.build(request())).resolves.toMatchObject({
      blocks: [{ source: 'skills', content: 'review: Review code.' }]
    });
    adapter.dispose();
    expect(tools.resolve()).toEqual([]);
  });
});

describe('NamespacedExtensionStorage', () => {
  it('isolates values by extension and prevents namespace escapes', async () => {
    const backend = new MemoryExtensionStorageBackend();
    const left = new NamespacedExtensionStorage('left', backend);
    const right = new NamespacedExtensionStorage('right', backend);
    await left.set('state/value', { count: 1 });
    await right.set('state/value', { count: 2 });

    await expect(left.get('state/value')).resolves.toEqual({ count: 1 });
    await expect(right.get('state/value')).resolves.toEqual({ count: 2 });
    await expect(left.list('state/')).resolves.toEqual(['state/value']);
    await expect(left.set('../right/state', true)).rejects.toThrow('extension_storage_invalid_key');
  });
});
