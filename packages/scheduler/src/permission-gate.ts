import type { PermissionDecision, PermissionGate, ToolCall } from '@desktop-agent/contracts';

export const SCHEDULER_READ_TOOL_NAMES = new Set([
  'schedule_list',
  'schedule_get',
  'schedule_runs'
]);

export const SCHEDULER_CONTROL_TOOL_NAMES = new Set([
  'schedule_create',
  'schedule_update',
  'schedule_set_enabled',
  'schedule_delete',
  'schedule_run_now',
  'schedule_cancel_run'
]);

export const SCHEDULER_TOOL_NAMES = new Set([
  ...SCHEDULER_READ_TOOL_NAMES,
  ...SCHEDULER_CONTROL_TOOL_NAMES
]);

type PermissionContext = { sessionId: string; workingDirectory: string };

export class SchedulerPermissionGate implements PermissionGate {
  constructor(private readonly inner: PermissionGate) {}

  check(call: ToolCall, context: PermissionContext): Promise<PermissionDecision> {
    if (SCHEDULER_TOOL_NAMES.has(call.name)) return Promise.resolve({ decision: 'allow' });
    return this.inner.check(call, context);
  }
}
