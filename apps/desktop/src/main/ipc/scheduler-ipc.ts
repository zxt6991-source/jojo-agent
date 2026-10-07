import {
  IPC,
  ScheduleIdInputSchema, ScheduleRunIdInputSchema,
  type ScheduleContract, type ScheduleRunContract,
  type WorkerCommand
} from '@desktop-agent/contracts';
import { APPLICATION_OPERATIONS } from '@desktop-agent/contracts/application/operations';
import { ipcMain, type IpcMainInvokeEvent } from 'electron';

interface Context {
  assertTrusted: (event: IpcMainInvokeEvent) => void;
  requestScheduler: (command: Extract<WorkerCommand, {
    type: 'scheduler.list' | 'scheduler.get' | 'scheduler.save' | 'scheduler.delete' | 'scheduler.enabled'
    | 'scheduler.run-now' | 'scheduler.runs.list' | 'scheduler.run.cancel'
  }>) => Promise<SchedulerResponse>;
}

export function registerSchedulerIpc(ctx: Context): void {
  ipcMain.handle(IPC.listSchedules, async (event) => {
    ctx.assertTrusted(event);
    const response = await ctx.requestScheduler({ type: 'scheduler.list', requestId: crypto.randomUUID() });
    return response.schedules ?? [];
  });
  ipcMain.handle(IPC.getSchedule, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = ScheduleIdInputSchema.parse(raw);
    const response = await ctx.requestScheduler({ type: 'scheduler.get', requestId: crypto.randomUUID(), ...input });
    if (!response.schedule) throw new Error('Scheduler returned no schedule.');
    return response.schedule;
  });
  ipcMain.handle(IPC.saveSchedule, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = APPLICATION_OPERATIONS['schedule.save'].input.parse(raw);
    const response = await ctx.requestScheduler({ type: 'scheduler.save', requestId: crypto.randomUUID(), input });
    if (!response.schedule) throw new Error('Scheduler save returned no schedule.');
    return response.schedule;
  });
  ipcMain.handle(IPC.deleteSchedule, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = ScheduleIdInputSchema.parse(raw);
    await ctx.requestScheduler({ type: 'scheduler.delete', requestId: crypto.randomUUID(), ...input });
  });
  ipcMain.handle(IPC.setScheduleEnabled, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = APPLICATION_OPERATIONS['schedule.enabled'].input.parse(raw);
    const response = await ctx.requestScheduler({ type: 'scheduler.enabled', requestId: crypto.randomUUID(), input });
    if (!response.schedule) throw new Error('Scheduler enable update returned no schedule.');
    return response.schedule;
  });
  ipcMain.handle(IPC.runScheduleNow, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = ScheduleIdInputSchema.parse(raw);
    const response = await ctx.requestScheduler({ type: 'scheduler.run-now', requestId: crypto.randomUUID(), ...input });
    if (!response.run) throw new Error('Scheduler returned no run.');
    return response.run;
  });
  ipcMain.handle(IPC.listScheduleRuns, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = ScheduleIdInputSchema.parse(raw);
    const response = await ctx.requestScheduler({ type: 'scheduler.runs.list', requestId: crypto.randomUUID(), ...input });
    return response.runs ?? [];
  });
  ipcMain.handle(IPC.cancelScheduleRun, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = ScheduleRunIdInputSchema.parse(raw);
    await ctx.requestScheduler({ type: 'scheduler.run.cancel', requestId: crypto.randomUUID(), ...input });
  });

}

type SchedulerResponse = {
  schedules?: ScheduleContract[];
  schedule?: ScheduleContract;
  runs?: ScheduleRunContract[];
  run?: ScheduleRunContract;
};
