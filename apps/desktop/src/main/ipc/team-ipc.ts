import {
  DeleteTeamInputSchema,
  IPC,
  ListTeamsInputSchema,
  SaveTeamInputSchema, SetTeamMemberEnabledInputSchema,
  type TeamSnapshot, type TeamStatusSnapshot, type WorkerCommand
} from '@desktop-agent/contracts';
import { ipcMain, type IpcMainInvokeEvent } from 'electron';

interface Context {
  assertTrusted: (event: IpcMainInvokeEvent) => void;
  requestTeam: (command: Extract<WorkerCommand, {
    type: 'team.list' | 'team.status' | 'team.save' | 'team.delete' | 'team.member.enabled'
  }>) => Promise<{ teams?: TeamSnapshot[]; team?: TeamSnapshot; status?: TeamStatusSnapshot }>;
}

export function registerTeamIpc(ctx: Context): void {
  ipcMain.handle(IPC.listTeams, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = ListTeamsInputSchema.parse(raw ?? {});
    const response = await ctx.requestTeam({
      type: 'team.list', requestId: crypto.randomUUID(),
      ...(input.workspace ? { workspace: input.workspace } : {})
    });
    return response.teams ?? [];
  });
  ipcMain.handle(IPC.getTeamStatus, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = DeleteTeamInputSchema.parse(raw);
    const response = await ctx.requestTeam({ type: 'team.status', requestId: crypto.randomUUID(), teamId: input.teamId });
    if (!response.status) throw new Error('Team status returned no snapshot.');
    return response.status;
  });
  ipcMain.handle(IPC.saveTeam, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = SaveTeamInputSchema.parse(raw);
    const response = await ctx.requestTeam({ type: 'team.save', requestId: crypto.randomUUID(), input });
    if (!response.team) throw new Error('Team save returned no team.');
    return response.team;
  });
  ipcMain.handle(IPC.deleteTeam, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = DeleteTeamInputSchema.parse(raw);
    await ctx.requestTeam({ type: 'team.delete', requestId: crypto.randomUUID(), teamId: input.teamId });
  });
  ipcMain.handle(IPC.setTeamMemberEnabled, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = SetTeamMemberEnabledInputSchema.parse(raw);
    const response = await ctx.requestTeam({
      type: 'team.member.enabled', requestId: crypto.randomUUID(),
      teamId: input.teamId, memberId: input.memberId, enabled: input.enabled
    });
    if (!response.team) throw new Error('Team member update returned no team.');
    return response.team;
  });

}
