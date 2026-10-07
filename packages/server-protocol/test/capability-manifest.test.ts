import { describe, expect, it } from 'vitest';
import { BUILD_COMPATIBILITY } from '@desktop-agent/contracts/build-compatibility';
import { CAPABILITY_MANIFEST, createServerCapabilityDefaults, SCHEDULER_TARGETS } from '@desktop-agent/contracts/capability-manifest';
import { JOJO_SERVER_PROTOCOL_VERSION, ServerCapabilitiesSchema } from '../src/index.js';

describe('capability manifest', () => {
  it('advertises only enabled optional services in a valid protocol snapshot', () => {
    const disabled = createServerCapabilityDefaults({ scheduler: false, channels: false, channelKinds: ['feishu'] });
    expect(ServerCapabilitiesSchema.parse(disabled)).toEqual(disabled);
    expect(disabled.scheduler).toEqual({ enabled: false, targets: [] });
    expect(disabled.channels).toEqual({ enabled: false, kinds: [], inbound: false, outbound: false, approvals: false });
    const enabled = createServerCapabilityDefaults({ scheduler: true, channels: true, channelKinds: ['feishu'] });
    expect(ServerCapabilitiesSchema.parse(enabled)).toEqual(enabled);
    expect(enabled.scheduler.targets).toEqual(['agent']);
    expect(enabled.channels.kinds).toEqual(['feishu']);
    expect(enabled.workflow).toBe(false);
    expect(SCHEDULER_TARGETS.desktop).toEqual(['agent', 'workflow', 'team_member']);
  });

  it('returns independent mutable snapshots without mutating the registry', () => {
    const kinds = ['feishu'];
    const first = createServerCapabilityDefaults({ scheduler: true, channels: true, channelKinds: kinds });
    first.scheduler.targets.push('workflow');
    first.channels.kinds.push('telegram');
    const second = createServerCapabilityDefaults({ scheduler: true, channels: true, channelKinds: kinds });
    expect(second.scheduler.targets).toEqual(['agent']);
    expect(second.channels.kinds).toEqual(['feishu']);
    expect(new Set(CAPABILITY_MANIFEST.map((item) => item.id)).size).toBe(CAPABILITY_MANIFEST.length);
    expect(JOJO_SERVER_PROTOCOL_VERSION).toBe(BUILD_COMPATIBILITY.serverProtocol);
  });
});
