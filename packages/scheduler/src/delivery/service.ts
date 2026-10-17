import type { Schedule, ScheduleRun } from '../types.js';

export function scheduleDeliveryContent(schedule: Schedule, run: ScheduleRun): string | undefined {
  if (run.status === 'completed') {
    return run.targetSnapshot.kind === 'reminder' ? run.targetSnapshot.text : '任务已完成，请查看结果。';
  }
  if (run.status === 'failed' || run.status === 'interrupted') {
    return `“${schedule.name}”未完成，请查看运行记录。`;
  }
  return undefined;
}
