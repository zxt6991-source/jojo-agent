import type { TeamMemberSnapshot, TeamMessage, TeamSnapshot, TeamTaskSnapshot, TeamTaskState } from '@desktop-agent/contracts';

export interface TeamStore {
  createTeam(team: TeamSnapshot): Promise<TeamSnapshot>;
  getTeam(id: string): Promise<TeamSnapshot | undefined>;
  listTeams(workspace?: string): Promise<TeamSnapshot[]>;
  updateTeam(team: TeamSnapshot): Promise<TeamSnapshot>;
  updateMember(teamId: string, member: TeamMemberSnapshot): Promise<TeamMemberSnapshot>;
  deleteTeam(id: string): Promise<void>;
  createTask(task: TeamTaskSnapshot): Promise<TeamTaskSnapshot>;
  getTask(id: string): Promise<TeamTaskSnapshot | undefined>;
  listTasks(teamId: string, states?: TeamTaskState[]): Promise<TeamTaskSnapshot[]>;
  updateTask(task: TeamTaskSnapshot): Promise<TeamTaskSnapshot>;
  enqueueMessage(message: TeamMessage): Promise<TeamMessage>;
  getMessage(id: string): Promise<TeamMessage | undefined>;
  listInbox(input: { teamId: string; memberId?: string; includeRead?: boolean; limit?: number }): Promise<TeamMessage[]>;
  markMessageRead(id: string, readAt?: string): Promise<void>;
}
