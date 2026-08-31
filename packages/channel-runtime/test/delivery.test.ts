import { describe, expect, it } from 'vitest';
import type { ChannelService } from '../src/index.js';
import { ChannelScheduleDeliveryService, chunkChannelText } from '../src/index.js';
import type { Schedule, ScheduleRun } from '@desktop-agent/scheduler';

describe('channel delivery integration', () => {
  it('chunks long markdown without dropping fenced-code continuity', () => {
    const chunks = chunkChannelText(`Intro\n\n\`\`\`ts\n${'const value = 1;\n'.repeat(20)}\`\`\``, 100, true);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.join('\n')).toContain('const value = 1');
    expect(chunks.every((chunk) => chunk.length <= 108)).toBe(true);
  });

  it('uses binding ids for scheduler delivery and stable idempotency', async () => {
    const deliveries: Parameters<ChannelService['deliver']>[0][] = [];
    const channels = {
      deliver: async (input: Parameters<ChannelService['deliver']>[0]) => {
        deliveries.push(input);
        return { deliveryId: 'delivery', status: 'pending' as const };
      }
    } as ChannelService;
    const service = new ChannelScheduleDeliveryService(channels);
    const schedule = {
      id: 'schedule', name: 'Daily', enabled: true,
      delivery: { channels: [{ enabled: true, bindingId: 'feishu-me' }] }
    } as Schedule;
    const run = { id: 'run', scheduleId: 'schedule' } as ScheduleRun;
    await expect(service.deliver({ schedule, run, content: 'done' })).resolves.toMatchObject({
      status: 'delivered', destination: { kind: 'channel', id: 'feishu-me' }
    });
    expect(deliveries).toMatchObject([{
      bindingId: 'feishu-me', mode: 'system', idempotencyKey: 'schedule:run:feishu-me'
    }]);
  });
});
