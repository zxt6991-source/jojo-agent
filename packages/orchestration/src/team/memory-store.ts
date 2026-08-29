import type {
  TeamMemberSnapshot,
  TeamMessage,
  TeamSnapshot,
  TeamTaskSnapshot,
  TeamTaskState
} from '@desktop-agent/contracts';
import type { TeamStore } from './store.js';

export class MemoryTeamStore implements TeamStore {
  private readonly teams = new Map<string, TeamSnapshot>();
  private readonly tasks = new Map<string, TeamTaskSnapshot>();
  private readonly messages = new Map<string, TeamMessage>();

  async createTeam(team: TeamSnapshot): Promise<TeamSnapshot> {
    if (this.teams.has(team.id)) throw new Error(`team_exists: ${team.id}`);
    this.teams.set(team.id, structuredClone(team));
    return structuredClone(team);
  }

  async getTeam(id: string): Promise<TeamSnapshot | undefined> {
    const team = this.teams.get(id);
    return team ? structuredClone(team) : undefined;
  }

  async listTeams(workspace?: string): Promise<TeamSnapshot[]> {
    return [...this.teams.values()]
      .filter((team) => workspace === undefined || team.workspace === workspace)
      .map((team) => structuredClone(team));
  }

  async updateTeam(team: TeamSnapshot): Promise<TeamSnapshot> {
    if (!this.teams.has(team.id)) throw new Error(`team_not_found: ${team.id}`);
    this.teams.set(team.id, structuredClone(team));
    return structuredClone(team);
  }

  async updateMember(teamId: string, member: TeamMemberSnapshot): Promise<TeamMemberSnapshot> {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`team_not_found: ${teamId}`);
    const index = team.members.findIndex((candidate) => candidate.id === member.id);
    if (index < 0) throw new Error(`team_member_not_found: ${teamId}/${member.id}`);
    team.members[index] = structuredClone(member);
    return structuredClone(member);
  }

  async deleteTeam(id: string): Promise<void> {
    this.teams.delete(id);
    for (const [taskId, task] of this.tasks) if (task.teamId === id) this.tasks.delete(taskId);
    for (const [messageId, message] of this.messages) if (message.teamId === id) this.messages.delete(messageId);
  }

  async createTask(task: TeamTaskSnapshot): Promise<TeamTaskSnapshot> {
    this.tasks.set(task.id, structuredClone(task));
    return structuredClone(task);
  }

  async getTask(id: string): Promise<TeamTaskSnapshot | undefined> {
    const task = this.tasks.get(id);
    return task ? structuredClone(task) : undefined;
  }

  async listTasks(teamId: string, states?: TeamTaskState[]): Promise<TeamTaskSnapshot[]> {
    return [...this.tasks.values()]
      .filter((task) => task.teamId === teamId && (!states || states.includes(task.state)))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((task) => structuredClone(task));
  }

  async updateTask(task: TeamTaskSnapshot): Promise<TeamTaskSnapshot> {
    if (!this.tasks.has(task.id)) throw new Error(`team_task_not_found: ${task.id}`);
    this.tasks.set(task.id, structuredClone(task));
    return structuredClone(task);
  }

  async enqueueMessage(message: TeamMessage): Promise<TeamMessage> {
    this.messages.set(message.id, structuredClone(message));
    return structuredClone(message);
  }

  async getMessage(id: string): Promise<TeamMessage | undefined> {
    const message = this.messages.get(id);
    return message ? structuredClone(message) : undefined;
  }

  async listInbox(input: { teamId: string; memberId?: string; includeRead?: boolean; limit?: number }): Promise<TeamMessage[]> {
    return [...this.messages.values()]
      .filter((message) => message.teamId === input.teamId
        && (!input.memberId || message.recipientMemberId === input.memberId)
        && (input.includeRead || message.status === 'unread'))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, input.limit ?? 100)
      .map((message) => structuredClone(message));
  }

  async markMessageRead(id: string, readAt = new Date().toISOString()): Promise<void> {
    const message = this.messages.get(id);
    if (!message) throw new Error(`team_message_not_found: ${id}`);
    this.messages.set(id, { ...message, status: 'read', readAt });
  }
}
