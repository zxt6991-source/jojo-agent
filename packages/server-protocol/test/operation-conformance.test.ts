import { describe, expect, it } from 'vitest';
import { APPLICATION_OPERATIONS as operations } from '@desktop-agent/contracts/application/operations';
import { ApprovalInputSchema, DesktopChannelMutationSchema, StartTurnInputSchema, WorkerCommandSchema } from '@desktop-agent/contracts';
import { ClientCommandSchema, CreateChannelBindingInputSchema, CreateChannelInstanceInputSchema, CreateScheduleInputSchema } from '../src/index.js';

const binding = {
  id: 'binding', instanceId: 'feishu',
  conversation: { id: 'conversation', type: 'direct' },
  routing: { sessionMode: 'persistent' },
  policy: { enabled: true, requireMention: false, queueMode: 'queue', allowAttachments: false }
};
const desktopBinding = (value: unknown) => DesktopChannelMutationSchema.safeParse({ action: 'binding.save', binding: value });
const schedule = {
  name: 'Review', spec: { kind: 'cron', expression: '0 8 * * *', timezone: 'Asia/Shanghai' },
  target: { kind: 'agent', sessionId: 'session', providerId: 'test', model: 'test', input: { content: [{ type: 'text', text: 'Review' }] } }
};

describe('cross-transport operation contracts', () => {
  it('uses the same channel and schedule schemas in the registry and server public API', () => {
    expect(operations['channel.binding.create'].input).toBe(CreateChannelBindingInputSchema);
    expect(operations['channel.instance.create'].input).toBe(CreateChannelInstanceInputSchema);
    expect(operations['schedule.create'].input).toBe(CreateScheduleInputSchema);
    expect(operations['run.start'].idempotent).toBe(false);
    expect(operations['schedule.run-now'].idempotent).toBe(false);
    expect(operations['run.start'].permission).toBe('runs:start');
    expect(operations['channel.binding.create'].permission).toBe('channels:bind');
  });

  it.each([
    binding,
    { ...binding, conversation: { ...binding.conversation, type: 'broadcast' } },
    { ...binding, routing: { sessionMode: 'unknown' } },
    { ...binding, policy: { ...binding.policy, queueMode: 'drop' } },
    { ...binding, policy: { ...binding.policy, extra: true } }
  ])('preserves shared channel policy validation across Desktop and Server: %j', (value) => {
    const desktop = desktopBinding(value);
    const server = CreateChannelBindingInputSchema.safeParse(value);
    expect(desktop.success).toBe(server.success);
    if (desktop.success && desktop.data.action === 'binding.save' && server.success) {
      expect(desktop.data.binding).toEqual(server.data);
    }
  });

  it('keeps Desktop secret references restricted while allowing custom server adapters', () => {
    const instance = { id: 'instance', kind: 'feishu', name: 'Feishu', enabled: true, config: {}, secretRefs: { appSecret: 'raw-secret' } };
    expect(CreateChannelInstanceInputSchema.safeParse(instance).success).toBe(true);
    expect(DesktopChannelMutationSchema.safeParse({ action: 'instance.save', instance }).success).toBe(false);
    expect(DesktopChannelMutationSchema.safeParse({ action: 'instance.save', instance: { ...instance, secretRefs: { appSecret: 'secret://env/FEISHU_SECRET' } } }).success).toBe(true);
  });

  it.each([schedule, { ...schedule, unexpected: true }, { ...schedule, target: { ...schedule.target, input: { content: [] } } }])('shares schedule validation with the Worker envelope: %j', (input) => {
    expect(WorkerCommandSchema.safeParse({ type: 'scheduler.save', requestId: 'request', input }).success)
      .toBe(CreateScheduleInputSchema.safeParse(input).success);
  });

  it('preserves Desktop empty-turn validation, defaults and approval scopes', () => {
    expect(StartTurnInputSchema.safeParse({ sessionId: 's', text: '', providerId: 'test', model: 'test' }).success).toBe(false);
    const turn = { sessionId: 's', text: 'hello', providerId: ' test ', model: ' test ' };
    expect(StartTurnInputSchema.safeParse({ ...turn, providerId: ' ' }).success).toBe(false);
    expect(StartTurnInputSchema.safeParse({ ...turn, model: ' ' }).success).toBe(false);
    expect(StartTurnInputSchema.parse(turn)).toMatchObject({ providerId: 'test', model: 'test', images: [], files: [] });
    for (const scope of ['once', 'session', 'similar', 'conversation']) {
      const input = { requestId: 'approval', allow: true, scope };
      expect(WorkerCommandSchema.parse({ type: 'approval.resolve', ...input })).toEqual({ type: 'approval.resolve', ...ApprovalInputSchema.parse(input) });
    }
    // Network approval remains allow/deny; it must not silently accept unsupported grant scope.
    expect(ClientCommandSchema.safeParse({ id: 'request', type: 'approval.resolve', approvalId: 'approval', input: { decision: 'allow', scope: 'session' } }).success).toBe(false);
  });

  it('uses neutral session validation inside the strict WebSocket envelope', () => {
    const input = { title: '  Session  ' };
    expect(ClientCommandSchema.parse({ id: 'req', type: 'session.create', input })).toEqual({
      id: 'req', type: 'session.create', input: operations['session.create'].input.parse(input)
    });
    expect(ClientCommandSchema.safeParse({ id: 'req', type: 'session.create', input, extra: true }).success).toBe(false);
  });
});
