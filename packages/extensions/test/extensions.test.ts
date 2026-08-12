import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { McpServerConfig, PermissionGate } from '@desktop-agent/contracts';
import {
  createInstallSkillTool,
  createSkillTool,
  discoverSkills,
  ExtensionPermissionGate,
  DesktopMcpOAuthProvider,
  McpManager,
  userSkillDirectories,
  type McpClientConnection
} from '../src/index.js';

describe('Skills', () => {
  it('discovers metadata and loads the full SKILL.md only through the skill tool', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'desktop-agent-skills-'));
    const folder = path.join(root, 'reviewer');
    await mkdir(folder);
    await writeFile(path.join(folder, 'SKILL.md'), `---\nname: code-reviewer\ndescription: Review code for correctness.\n---\n\n# Workflow\nInspect tests first.`);

    const skills = await discoverSkills([root]);
    expect(skills).toMatchObject([{
      id: 'code-reviewer', name: 'code-reviewer', description: 'Review code for correctness.', enabled: true
    }]);
    const tool = createSkillTool(skills);
    expect(tool?.definition.description).toContain('Review code for correctness.');
    expect(tool?.definition.description).not.toContain('Inspect tests first.');
    await expect(tool!.execute({ skillId: 'code-reviewer' }, {
      sessionId: 's1', workingDirectory: root, signal: new AbortController().signal,
      approved: false, onProgress: () => undefined
    })).resolves.toMatchObject({ ok: true, content: expect.stringContaining('Inspect tests first.') });
  });

  it('keeps disabled skills out of the model-visible catalog', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'desktop-agent-skills-disabled-'));
    await writeFile(path.join(root, 'SKILL.md'), `---\nname: disabled-one\ndescription: Hidden workflow.\n---\nBody`);
    const skills = await discoverSkills([root], ['disabled-one']);
    expect(skills[0]?.enabled).toBe(false);
    expect(createSkillTool(skills)).toBeNull();
  });

  it('returns the standard user-level skill directories', () => {
    expect(userSkillDirectories('/home/example')).toEqual([
      path.join('/home/example', '.agents', 'skills'),
      path.join('/home/example', '.codex', 'skills'),
      path.join('/home/example', '.config', 'agents', 'skills')
    ]);
  });

  it('installs non-interactively and refreshes the skill catalog immediately', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'desktop-agent-install-skill-'));
    const skillRoot = path.join(root, '.agents', 'skills');
    const runCommand = vi.fn(async (_args: string[]) => {
      const folder = path.join(skillRoot, 'weread-skills');
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, 'SKILL.md'), `---\nname: weread-skills\ndescription: Work with WeRead books.\n---\nInstructions`);
      return { callId: '', ok: true, content: 'installed' };
    });
    let refreshCount = 0;
    const refreshSkills = async () => {
      refreshCount += 1;
      return discoverSkills([skillRoot]);
    };
    const tool = createInstallSkillTool({ runCommand, refreshSkills });

    await expect(tool.execute({ source: 'Tencent/WeChatReading', skills: ['weread-skills'] }, {
      sessionId: 's1', workingDirectory: root, signal: new AbortController().signal,
      approved: true, onProgress: () => undefined
    })).resolves.toMatchObject({
      ok: true,
      content: expect.stringContaining('weread-skills')
    });

    expect(runCommand).toHaveBeenCalledWith([
      '--yes', 'skills', 'add', 'Tencent/WeChatReading',
      '--skill', 'weread-skills',
      '--yes', '--agent', 'universal', '--copy'
    ], expect.objectContaining({ workingDirectory: root }));
    expect(refreshCount).toBe(2);
  });

  it('does not report success when the CLI creates no discoverable skill', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'desktop-agent-install-skill-empty-'));
    const tool = createInstallSkillTool({
      runCommand: async () => ({ callId: '', ok: true, content: 'exit 0' }),
      refreshSkills: () => discoverSkills([path.join(root, '.agents', 'skills')])
    });

    await expect(tool.execute({ source: 'owner/repository' }, {
      sessionId: 's1', workingDirectory: root, signal: new AbortController().signal,
      approved: true, onProgress: () => undefined
    })).resolves.toMatchObject({ ok: false, code: 'skill_install_unverified' });
  });

  it('requires approval before installing a skill', async () => {
    const base: PermissionGate = { check: vi.fn(async () => ({ decision: 'deny' as const, reason: 'unknown' })) };
    const gate = new ExtensionPermissionGate(base);
    const decision = await gate.check({
      id: 'install-1',
      name: 'install_skill',
      input: { source: 'owner/repository' }
    }, { sessionId: 's1', workingDirectory: process.cwd() });

    expect(decision).toMatchObject({
      decision: 'ask',
      request: { reason: 'Install Agent Skills into the current workspace' }
    });
    expect(base.check).not.toHaveBeenCalled();
  });
});

describe('McpManager', () => {
  it('reports OAuth HTTP servers as requiring authorization before connecting', async () => {
    const connectionFactory = vi.fn();
    const manager = new McpManager(() => undefined, connectionFactory);
    await manager.configure([{
      id: 'oauth', name: 'OAuth MCP', enabled: true, transport: 'streamable_http',
      url: 'https://example.com/mcp', versionNegotiation: 'auto', auth: { type: 'oauth' }
    }]);
    expect(manager.getStatuses()).toEqual([{
      serverId: 'oauth', name: 'OAuth MCP', state: 'auth_required', toolCount: 0, authType: 'oauth'
    }]);
    expect(connectionFactory).not.toHaveBeenCalled();
  });

  it('connects an authorized regional OAuth server through its validated canonical resource URL', async () => {
    const connection: McpClientConnection = {
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({ content: [] }),
      close: async () => undefined
    };
    const connectionFactory = vi.fn(async () => connection);
    const manager = new McpManager(() => undefined, connectionFactory);
    await manager.configure([{
      id: 'coros', name: 'COROS', enabled: true, transport: 'streamable_http',
      url: 'https://mcp.coros.com/mcp', versionNegotiation: 'legacy',
      auth: { type: 'oauth', resourceOrigins: ['https://mcpcn.coros.com/'] }
    }], {
      coros: {
        redirectUrl: 'http://127.0.0.1:4321/oauth/callback',
        latestIssuer: 'https://mcpcn.coros.com',
        tokens: {
          'https://mcpcn.coros.com': {
            access_token: 'secret', token_type: 'Bearer', issuer: 'https://mcpcn.coros.com'
          }
        },
        discoveryState: {
          authorizationServerUrl: 'https://mcpcn.coros.com',
          resourceMetadata: {
            resource: 'https://mcpcn.coros.com/mcp',
            authorization_servers: ['https://mcpcn.coros.com']
          }
        }
      }
    });
    expect(connectionFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://mcpcn.coros.com/mcp', versionNegotiation: 'legacy'
      }),
      expect.any(DesktopMcpOAuthProvider)
    );
    expect(manager.getStatuses()).toEqual([{
      serverId: 'coros', name: 'COROS', state: 'connected', toolCount: 0, authType: 'oauth'
    }]);
  });

  it('connects, reports status, and lazily activates a large tool catalog', async () => {
    const callTool = vi.fn(async (name: string, _input: Record<string, unknown>, _signal: AbortSignal) => ({
      content: [{ type: 'text' as const, text: `called ${name}` }]
    }));
    const connection: McpClientConnection = {
      listTools: async () => ({ tools: Array.from({ length: 25 }, (_, index) => ({
        name: `remote_${index}`,
        description: index === 17 ? 'Look up weather forecasts' : `Capability ${index}`,
        inputSchema: { type: 'object' as const }
      })) }),
      callTool: (name, input, signal) => callTool(name, input, signal),
      close: async () => undefined
    };
    const statuses = vi.fn();
    const manager = new McpManager(statuses, async (_config: McpServerConfig) => connection);
    await manager.configure([{
      id: 'demo', name: 'Demo', enabled: true, transport: 'stdio', command: 'demo', args: []
    }]);

    expect(manager.getStatuses()).toEqual([{ serverId: 'demo', name: 'Demo', state: 'connected', toolCount: 25 }]);
    expect(manager.getTools().map((tool) => tool.definition.name)).toEqual(['mcp_search_tools']);
    const search = manager.getTools()[0]!;
    await search.execute({ query: 'weather' }, {
      sessionId: 's1', workingDirectory: process.cwd(), signal: new AbortController().signal,
      approved: false, onProgress: () => undefined
    });
    const activated = manager.getTools().find((tool) => tool.definition.name.includes('remote_17'));
    expect(activated).toBeDefined();
    await expect(activated!.execute({}, {
      sessionId: 's1', workingDirectory: process.cwd(), signal: new AbortController().signal,
      approved: true, onProgress: () => undefined
    })).resolves.toMatchObject({ ok: true, content: 'called remote_17' });
    expect(callTool).toHaveBeenCalledWith('remote_17', {}, expect.any(AbortSignal));
    await manager.close();
  });
});

describe('DesktopMcpOAuthProvider', () => {
  it('persists OAuth state per issuer without exposing it in MCP config', () => {
    const changed = vi.fn();
    const authorization = vi.fn();
    const provider = new DesktopMcpOAuthProvider({
      redirectUrl: 'http://127.0.0.1:4321/oauth/callback', state: 'expected-state', scopes: ['read', 'offline_access'],
      onChanged: changed, onAuthorization: authorization
    });
    const context = { issuer: 'https://identity.example' };
    provider.saveClientInformation({ client_id: 'client-1', issuer: context.issuer }, context);
    provider.saveTokens({ access_token: 'secret', token_type: 'Bearer', issuer: context.issuer }, context);
    provider.saveCodeVerifier('verifier');
    expect(provider.state()).toBe('expected-state');
    expect(provider.clientMetadata).toMatchObject({ scope: 'read offline_access', token_endpoint_auth_method: 'none' });
    expect(provider.clientInformation(context)).toMatchObject({ client_id: 'client-1' });
    expect(provider.tokens()).toMatchObject({ access_token: 'secret' });
    expect(provider.codeVerifier()).toBe('verifier');
    provider.redirectToAuthorization(new URL('https://identity.example/authorize'));
    expect(authorization).toHaveBeenCalledOnce();
    provider.invalidateCredentials('tokens');
    expect(provider.tokens()).toBeUndefined();
    expect(changed).toHaveBeenCalled();
  });

  it('accepts a cross-origin canonical resource only when its HTTPS metadata is hosted by that resource', async () => {
    const resource = 'https://mcpcn.coros.com/mcp';
    const provider = new DesktopMcpOAuthProvider({
      redirectUrl: 'http://127.0.0.1:4321/oauth/callback', state: 'state',
      resourceOrigins: ['https://mcpcn.coros.com/'],
      credentials: {
        discoveryState: {
          authorizationServerUrl: 'https://mcpcn.coros.com',
          resourceMetadataUrl: 'https://mcpcn.coros.com/.well-known/oauth-protected-resource/mcp',
          resourceMetadata: { resource, authorization_servers: ['https://mcpcn.coros.com'] }
        }
      },
      onChanged: () => undefined, onAuthorization: () => undefined
    });
    await expect(provider.validateResourceURL('https://mcp.coros.com/mcp', resource))
      .resolves.toEqual(new URL(resource));
  });

  it('accepts an explicitly allowed canonical resource after automatic discovery omits the metadata URL', async () => {
    const resource = 'https://mcpcn.coros.com/mcp';
    const provider = new DesktopMcpOAuthProvider({
      redirectUrl: 'http://127.0.0.1:4321/oauth/callback', state: 'state',
      resourceOrigins: ['https://mcpcn.coros.com/'],
      credentials: {
        discoveryState: {
          authorizationServerUrl: 'https://mcpcn.coros.com',
          resourceMetadata: { resource, authorization_servers: ['https://mcpcn.coros.com'] }
        }
      },
      onChanged: () => undefined, onAuthorization: () => undefined
    });
    await expect(provider.validateResourceURL('https://mcp.coros.com/mcp', resource))
      .resolves.toEqual(new URL(resource));
  });

  it('rejects cross-origin resources that are not bound to their discovered metadata origin', async () => {
    const provider = new DesktopMcpOAuthProvider({
      redirectUrl: 'http://127.0.0.1:4321/oauth/callback', state: 'state',
      resourceOrigins: ['https://resource.example/'],
      credentials: {
        discoveryState: {
          authorizationServerUrl: 'https://identity.example',
          resourceMetadataUrl: 'https://attacker.example/.well-known/oauth-protected-resource',
          resourceMetadata: { resource: 'https://resource.example/mcp' }
        }
      },
      onChanged: () => undefined, onAuthorization: () => undefined
    });
    await expect(provider.validateResourceURL('https://configured.example/mcp', 'https://resource.example/mcp'))
      .rejects.toThrow(/trusted canonical resource/u);
  });

  it('rejects an otherwise valid canonical resource when its origin was not explicitly allowed', async () => {
    const resource = 'https://region.example/mcp';
    const provider = new DesktopMcpOAuthProvider({
      redirectUrl: 'http://127.0.0.1:4321/oauth/callback', state: 'state',
      credentials: {
        discoveryState: {
          authorizationServerUrl: 'https://region.example',
          resourceMetadataUrl: 'https://region.example/.well-known/oauth-protected-resource/mcp',
          resourceMetadata: { resource }
        }
      },
      onChanged: () => undefined, onAuthorization: () => undefined
    });
    await expect(provider.validateResourceURL('https://gateway.example/mcp', resource))
      .rejects.toThrow(/trusted canonical resource/u);
  });
});
