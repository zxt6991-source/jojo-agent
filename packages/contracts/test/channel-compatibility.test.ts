import { expect, it } from 'vitest';
import { ChannelDeliveryListQuerySchema, ChannelDeliverySchema } from '../src/application/channels.js';

it('returns and filters historical parts blocked by an earlier delivery failure', () => {
  const delivery = {
    id: 'historical-part-1', instanceId: 'historical-feishu', conversationId: 'offline-conversation',
    status: 'blocked', attemptCount: 0, createdAt: '2026-10-13T00:00:00.000Z',
    lastError: 'A preceding delivery part failed.'
  };
  expect(ChannelDeliverySchema.parse(delivery)).toEqual(delivery);
  expect(ChannelDeliveryListQuerySchema.parse({ status: delivery.status, limit: '10' }))
    .toEqual({ status: 'blocked', limit: 10 });
});
