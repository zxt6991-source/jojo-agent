import { describe, expect, it, vi } from 'vitest';
import type { SessionMeta } from '@desktop-agent/contracts';
import { SessionMetadataService, type SessionMetadataServiceOptions } from '../src/session-metadata-service';

const meta: SessionMeta = { id: 'session', title: 'Example', workingDirectory: '/work', createdAt: '2026-01-01', updatedAt: '2026-01-01' };
function fixture() {
  const options: SessionMetadataServiceOptions = {
    store: { list: vi.fn(async () => [meta]), get: vi.fn(async () => meta), create: vi.fn(async () => meta), rename: vi.fn(async () => {}), bindProject: vi.fn(async () => meta), delete: vi.fn(async () => {}) },
    defaultDirectory: '/general', ensureDirectory: vi.fn(async () => {}), resolveProject: vi.fn(async () => ({ id: 'project', displayName: 'Work', canonicalPath: '/work' })),
    readMessages: vi.fn(async () => []), stopSession: vi.fn(async () => {}), deleteRuntimeSession: vi.fn(async () => {}), deleteApplicationSession: vi.fn(async () => {})
  };
  return { options, service: new SessionMetadataService(options) };
}
describe('SessionMetadataService', () => {
  it('uses the default workspace for an unbound conversation', async () => {
    const { service, options } = fixture();
    await service.execute({ action: 'create', title: 'Example' });
    expect(options.ensureDirectory).toHaveBeenCalledWith('/general');
    expect(options.resolveProject).not.toHaveBeenCalled();
    expect(options.store.create).toHaveBeenCalledWith('Example', '/general', undefined, false);
  });
  it('validates the project before binding it', async () => {
    const { service, options } = fixture();
    vi.mocked(options.resolveProject).mockResolvedValue(undefined);
    await expect(service.execute({ action: 'bindProject', sessionId: 'session', workingDirectory: '/missing' })).rejects.toThrow('目录');
    expect(options.store.bindProject).not.toHaveBeenCalled();
  });
  it('coalesces deletion, blocks mutations, and writes tombstones before database cleanup', async () => {
    const { service, options } = fixture();
    let release!: () => void;
    const calls: string[] = [];
    options.stopSession = async () => { calls.push('stop'); await new Promise<void>(resolve => { release = resolve; }); };
    options.store.delete = async () => { calls.push('tombstone'); };
    options.deleteRuntimeSession = async () => { calls.push('runtime'); };
    options.deleteApplicationSession = async () => { calls.push('application'); };
    const first = service.execute({ action: 'delete', sessionId: 'session' });
    const second = service.execute({ action: 'delete', sessionId: 'session' });
    await expect(service.execute({ action: 'rename', sessionId: 'session', title: 'Late' })).rejects.toThrow('session_deleting');
    expect(await service.execute({ action: 'list' })).toEqual([]);
    release(); await Promise.all([first, second]);
    expect(calls).toEqual(['stop', 'tombstone', 'runtime', 'application']);
    expect(options.store.rename).not.toHaveBeenCalled();
  });
  it('does not delete data if stopping fails and allows a retry', async () => {
    const { service, options } = fixture();
    vi.mocked(options.stopSession).mockRejectedValueOnce(new Error('stop failed'));
    await expect(service.execute({ action: 'delete', sessionId: 'session' })).rejects.toThrow('stop failed');
    expect(options.store.delete).not.toHaveBeenCalled();
    await service.execute({ action: 'delete', sessionId: 'session' });
    expect(options.store.delete).toHaveBeenCalledTimes(1);
  });
  it('rejects a bind that finishes resolving its project during deletion', async () => {
    const { service, options } = fixture();
    let projectReady!: (value: { id: string; displayName: string; canonicalPath: string }) => void;
    let stopped!: () => void;
    options.stopSession = () => new Promise(resolve => { stopped = resolve; });
    options.resolveProject = () => new Promise(resolve => { projectReady = resolve; });
    const binding = service.execute({ action: 'bindProject', sessionId: 'session', workingDirectory: '/work' });
    const deleting = service.execute({ action: 'delete', sessionId: 'session' });
    projectReady({ id: 'project', displayName: 'Work', canonicalPath: '/work' });
    await expect(binding).rejects.toThrow('session_deleting');
    stopped(); await deleting;
    expect(options.store.bindProject).not.toHaveBeenCalled();
  });
});
