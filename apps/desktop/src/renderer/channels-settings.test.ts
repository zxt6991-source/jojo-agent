import { describe, expect, it } from 'vitest';
import {
  channelBindingDraft,
  channelInstanceDraft,
  createChannelBindingDraft,
  createChannelInstanceDraft,
  switchChannelInstanceKind
} from './ChannelsSettings';

describe('Channels settings helpers', () => {
  it('creates secure adapter defaults without embedding Feishu secrets', () => {
    const telegram = createChannelInstanceDraft('telegram');
    const feishu = createChannelInstanceDraft('feishu');

    expect(telegram.secretRefs).toEqual({ botToken: 'secret://env/JOJO_TELEGRAM_BOT_TOKEN' });
    expect(feishu.secretRefs).toEqual({});
    expect(feishu.config).toEqual({ appId: '', transport: 'websocket' });
    expect(JSON.stringify([telegram, feishu])).not.toContain('plaintext');
  });

  it('preserves legacy Feishu webhook mode when transport is absent', () => {
    const draft = channelInstanceDraft({
      id: 'feishu-legacy', kind: 'feishu', name: 'Legacy', enabled: true,
      config: { appId: 'cli_0123456789abcdef' },
      secretRefs: {
        appSecret: 'secret://env/JOJO_FEISHU_APP_SECRET',
        verificationToken: 'secret://env/JOJO_FEISHU_VERIFICATION_TOKEN'
      },
      revision: 1, fingerprint: 'fp', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
    });

    expect(draft.config.transport).toBe('webhook');
  });

  it('regenerates a matching instance id when a new draft changes platform', () => {
    const telegram = createChannelInstanceDraft('telegram');
    const feishu = switchChannelInstanceKind(telegram, 'feishu');

    expect(telegram.id).toMatch(/^telegram-/);
    expect(feishu.id).toMatch(/^feishu-/);
    expect(feishu.name).toBe('Feishu');
    expect(feishu.kind).toBe('feishu');
    expect(feishu.secretRefs).toEqual({});

    const custom = switchChannelInstanceKind({ ...telegram, name: '工作机器人' }, 'feishu');
    expect(custom.name).toBe('工作机器人');
  });

  it('strips persistence-owned instance metadata when editing', () => {
    const draft = channelInstanceDraft({
      id: 'telegram-personal', kind: 'telegram', name: 'Personal', enabled: true,
      config: { pollingTimeoutSeconds: 20 }, secretRefs: { botToken: 'secret://env/TOKEN' },
      revision: 7, fingerprint: 'server-owned', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z'
    });

    expect(draft).toEqual({
      id: 'telegram-personal', kind: 'telegram', name: 'Personal', enabled: true,
      config: { pollingTimeoutSeconds: 20 }, secretRefs: { botToken: 'secret://env/TOKEN' }
    });
    expect(draft).not.toHaveProperty('revision');
    expect(draft).not.toHaveProperty('fingerprint');
  });

  it('creates and edits bindings without renderer-owned revisions', () => {
    const created = createChannelBindingDraft('telegram-personal');
    expect(created.instanceId).toBe('telegram-personal');
    expect(created.policy.queueMode).toBe('queue');

    const edited = channelBindingDraft({
      id: 'binding-personal',
      instanceId: 'telegram-personal',
      conversation: { id: 'chat-1', type: 'direct' },
      routing: { sessionMode: 'persistent' },
      policy: { enabled: true, requireMention: false, queueMode: 'queue', allowAttachments: false },
      revision: 3,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z'
    });
    expect(edited.id).toBe('binding-personal');
    expect(edited).not.toHaveProperty('revision');
    expect(edited).not.toHaveProperty('updatedAt');
  });
});
