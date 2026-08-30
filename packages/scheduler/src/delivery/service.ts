import type { Schedule, ScheduleRun } from '../types.js';

export function scheduleDeliveryContent(schedule: Schedule, run: ScheduleRun): string | undefined {
  if (run.status === 'completed') {
    return run.resultPreview?.trim() || `“${schedule.name}”已完成，但没有产生文本输出。`;
  }
  if (run.status === 'failed' || run.status === 'interrupted') {
    const reason = run.error?.trim() || run.errorCode || '后台执行未能完成。';
    return `⚠️ ${schedule.name}未完成\n\n${reason}`;
  }
  return undefined;
}
