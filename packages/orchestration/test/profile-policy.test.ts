import { describe, expect, it } from 'vitest';
import type { ToolContext } from '@desktop-agent/contracts';
import {
  AgentExecutionScheduler,
  AgentProfileRegistry,
  createBuiltinAgentProfileRegistry,
  createSubAgentTools,
  emptyUsage,
  type LeafAgentRunRequest,
  resolveAgentToolPolicy,
  SubAgentManager
} from '../src/index.js';

const availableTools = [
  'read_file', 'list_files', 'grep', 'glob', 'web_search', 'web_fetch',
  'write_file', 'edit_file', 'delete_file', 'terminal'
];

describe('AgentProfileRegistry', () => {
  it('provides the four built-in profiles and returns defensive copies', () => {
    const registry = createBuiltinAgentProfileRegistry();
    expect(registry.list().map((profile) => profile.name)).toEqual(['code-review', 'explore', 'general', 'synthesize']);
    const explore = registry.get('explore');
    explore.allowedTools?.push('write_file');
    expect(registry.get('explore').allowedTools).not.toContain('write_file');
  });

  it('returns a stable invalid_profile error', () => {
    const registry = createBuiltinAgentProfileRegistry();
    expect(() => registry.get('missing')).toThrowError(expect.objectContaining({ code: 'invalid_profile' }));
  });
});

describe('Agent Tool Policy', () => {
  it('enforces profile allow/deny and runtime read-only restrictions', () => {
    const registry = createBuiltinAgentProfileRegistry();
    expect(resolveAgentToolPolicy(availableTools, registry.get('explore'))).toEqual({
      readOnly: true,
      allowedTools: ['glob', 'grep', 'list_files', 'read_file', 'web_fetch', 'web_search']
    });
    expect(resolveAgentToolPolicy(availableTools, registry.get('synthesize'), {
      tools: { allow: ['read_file', 'write_file'] }, readOnly: false
    })).toEqual({ readOnly: true, allowedTools: [] });
    expect(resolveAgentToolPolicy(availableTools, registry.get('general'), {
      tools: { allow: ['read_file', 'write_file', 'terminal'], deny: ['write_file'] }
    })).toEqual({ readOnly: false, allowedTools: ['read_file', 'terminal'] });
    expect(resolveAgentToolPolicy(availableTools, registry.get('general'), { readOnly: true }).allowedTools)
      .toEqual(['glob', 'grep', 'list_files', 'read_file', 'web_fetch', 'web_search']);
  });

  it('passes resolved profile defaults and request restrictions into the leaf runner', async () => {
    const registry = new AgentProfileRegistry([{
      name: 'focused', description: 'Focused test profile', systemPrompt: 'Focus.', readOnly: true,
      allowedTools: ['read_file', 'grep'], model: 'profile-model', maxIterations: 3, timeoutMs: 15_000
    }]);
    let captured: LeafAgentRunRequest | undefined;
    const manager = new SubAgentManager({
      run: async (request) => {
        captured = request;
        return { result: 'done', stopReason: 'stop', usage: emptyUsage(), incomplete: false };
      }
    }, new AgentExecutionScheduler(1), () => undefined, { profileRegistry: registry });
    const agent = manager.start({
      sessionId: 'session', workingDirectory: process.cwd(), task: 'Inspect', profile: 'focused',
      providerId: 'provider', model: 'inherited-model', tools: { allow: ['read_file'] }, readOnly: true
    });
    await manager.wait([agent.id], new AbortController().signal, 1_000);
    expect(captured).toMatchObject({
      profile: 'focused', model: 'profile-model', maxIterations: 3, timeoutMs: 15_000,
      tools: { allow: ['read_file'] }, readOnly: true
    });
  });

  it('accepts registered profiles through sub_agent_start and exposes invalid_profile', async () => {
    let captured: LeafAgentRunRequest | undefined;
    const manager = new SubAgentManager({
      run: async (request) => {
        captured = request;
        return { result: 'done', stopReason: 'stop', usage: emptyUsage(), incomplete: false };
      }
    }, new AgentExecutionScheduler(1), () => undefined);
    const tools = createSubAgentTools(manager, { providerId: 'provider', model: 'default-model' });
    const context: ToolContext = {
      sessionId: 'session', workingDirectory: process.cwd(), signal: new AbortController().signal,
      approved: true, onProgress: () => undefined
    };
    const started = await tools[0]!.execute({
      task: 'Review code', profile: 'code-review', model: 'review-model', maxIterations: 4,
      tools: { allow: ['read_file', 'grep'], deny: ['grep'] }, readOnly: true
    }, context);
    expect(started.ok).toBe(true);
    const id = (JSON.parse(started.content) as { id: string }).id;
    await manager.wait([id], context.signal, 1_000);
    expect(captured).toMatchObject({
      profile: 'code-review', model: 'review-model', maxIterations: 4,
      tools: { allow: ['read_file', 'grep'], deny: ['grep'] }, readOnly: true
    });

    const invalid = await tools[0]!.execute({ task: 'Unknown', profile: 'missing' }, context);
    expect(invalid).toMatchObject({ ok: false, code: 'invalid_profile' });
  });
});
