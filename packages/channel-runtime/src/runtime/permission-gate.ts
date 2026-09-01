import type { PermissionDecision, PermissionGate, ToolCall } from '@desktop-agent/contracts';

type PermissionContext = { sessionId: string; workingDirectory: string };

export class ChannelPermissionGate implements PermissionGate {
  constructor(private readonly inner: PermissionGate) {}

  check(call: ToolCall, context: PermissionContext): Promise<PermissionDecision> {
    if (call.name === 'channel_list_targets') return Promise.resolve({ decision: 'allow' });
    if (call.name === 'channel_send') {
      return Promise.resolve({
        decision: 'ask',
        request: {
          requestId: crypto.randomUUID(),
          sessionId: context.sessionId,
          call,
          reason: '向已绑定的外部 Channel 会话发送消息'
        }
      });
    }
    return this.inner.check(call, context);
  }
}
