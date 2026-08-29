import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  TeamMessageSchema,
  TeamSnapshotSchema,
  TeamTaskSnapshotSchema,
  type TeamMessage,
  type TeamMemberSnapshot,
  type TeamSnapshot,
  type TeamTaskSnapshot,
  type TeamTaskState
} from '@desktop-agent/contracts';

type Row = Record<string, unknown>;

function text(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`team_store_invalid_${name}`);
  return value;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function integer(value: unknown, name: string): number {
  if (typeof value !== 'number') throw new Error(`team_store_invalid_${name}`);
  return value;
}

function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  return JSON.parse(value) as T;
}

function memberFromRow(row: Row): TeamMemberSnapshot {
  const description = optionalText(row.description);
  const providerId = optionalText(row.provider_id);
  const model = optionalText(row.model);
  const systemPrompt = optionalText(row.system_prompt);
  return {
    id: text(row.id, 'member_id'),
    name: text(row.name, 'member_name'),
    ...(description ? { description } : {}),
    profile: text(row.profile, 'profile'),
    ...(providerId ? { providerId } : {}),
    ...(model ? { model } : {}),
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(row.read_only === null ? {} : { readOnly: integer(row.read_only, 'read_only') === 1 }),
    ...(row.tool_policy_json === null ? {} : { tools: json(row.tool_policy_json, {}) }),
    ...(row.spawn_policy_json === null ? {} : { spawn: json(row.spawn_policy_json, { enabled: false }) }),
    laneId: text(row.lane_id, 'lane_id'),
    state: text(row.state, 'member_state') as TeamMemberSnapshot['state'],
    revision: integer(row.revision, 'member_revision'),
    createdAt: text(row.created_at, 'member_created_at'),
    updatedAt: text(row.updated_at, 'member_updated_at')
  };
}

function taskFromRow(row: Row): TeamTaskSnapshot {
  return TeamTaskSnapshotSchema.parse({
    id: row.id,
    teamId: row.team_id,
    memberId: row.member_id,
    ...(optionalText(row.parent_session_id) ? { parentSessionId: row.parent_session_id } : {}),
    ...(optionalText(row.parent_run_id) ? { parentRunId: row.parent_run_id } : {}),
    ...(optionalText(row.parent_actor_id) ? { parentActorId: row.parent_actor_id } : {}),
    ...(optionalText(row.runtime_run_id) ? { runtimeRunId: row.runtime_run_id } : {}),
    input: row.input,
    state: row.status,
    ...(optionalText(row.result) ? { result: row.result } : {}),
    ...(row.structured_result_json === null ? {} : { structuredResult: json(row.structured_result_json, null) }),
    ...(row.schema_valid === null ? {} : { schemaValid: integer(row.schema_valid, 'schema_valid') === 1 }),
    ...(optionalText(row.error_code) ? { errorCode: row.error_code } : {}),
    ...(optionalText(row.error) ? { error: row.error } : {}),
    ...(optionalText(row.stop_reason) ? { stopReason: row.stop_reason } : {}),
    providerId: row.provider_id,
    model: row.model,
    usage: json(row.usage_json, {}),
    incomplete: integer(row.incomplete, 'incomplete') === 1,
    ...(row.isolation_json === null ? {} : { isolation: json(row.isolation_json, null) }),
    createdAt: row.created_at,
    ...(optionalText(row.started_at) ? { startedAt: row.started_at } : {}),
    ...(optionalText(row.finished_at) ? { finishedAt: row.finished_at } : {})
  });
}

function messageFromRow(row: Row): TeamMessage {
  return TeamMessageSchema.parse({
    id: row.id,
    teamId: row.team_id,
    senderKind: row.sender_kind,
    ...(optionalText(row.sender_id) ? { senderId: row.sender_id } : {}),
    recipientMemberId: row.recipient_member_id,
    kind: row.message_kind,
    ...(optionalText(row.subject) ? { subject: row.subject } : {}),
    content: row.content,
    ...(optionalText(row.task_id) ? { taskId: row.task_id } : {}),
    status: row.status,
    createdAt: row.created_at,
    ...(optionalText(row.read_at) ? { readAt: row.read_at } : {})
  });
}

export class SqliteTeamStore {
  private readonly database: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    this.database = new DatabaseSync(filePath);
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS teams (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
        workspace TEXT NOT NULL, workspace_key TEXT NOT NULL, runtime_session_id TEXT NOT NULL UNIQUE,
        max_concurrency INTEGER NOT NULL, revision INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_teams_workspace ON teams(workspace);
      CREATE TABLE IF NOT EXISTS team_members (
        id TEXT NOT NULL, team_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT,
        profile TEXT NOT NULL, provider_id TEXT, model TEXT, system_prompt TEXT, read_only INTEGER,
        tool_policy_json TEXT, spawn_policy_json TEXT, lane_id TEXT NOT NULL, state TEXT NOT NULL,
        revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(team_id, id), FOREIGN KEY(team_id) REFERENCES teams(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS team_tasks (
        id TEXT PRIMARY KEY, team_id TEXT NOT NULL, member_id TEXT NOT NULL,
        parent_session_id TEXT, parent_run_id TEXT, parent_actor_id TEXT, runtime_run_id TEXT,
        input TEXT NOT NULL, status TEXT NOT NULL, result TEXT, structured_result_json TEXT,
        schema_valid INTEGER, error_code TEXT, error TEXT, stop_reason TEXT,
        provider_id TEXT NOT NULL, model TEXT NOT NULL,
        usage_json TEXT NOT NULL, incomplete INTEGER NOT NULL, isolation_json TEXT,
        created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
        FOREIGN KEY(team_id, member_id) REFERENCES team_members(team_id, id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_team_tasks_team_state ON team_tasks(team_id, status, created_at);
      CREATE TABLE IF NOT EXISTS team_messages (
        id TEXT PRIMARY KEY, team_id TEXT NOT NULL, sender_kind TEXT NOT NULL, sender_id TEXT,
        recipient_member_id TEXT NOT NULL, message_kind TEXT NOT NULL, subject TEXT, content TEXT NOT NULL,
        task_id TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT,
        FOREIGN KEY(team_id, recipient_member_id) REFERENCES team_members(team_id, id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_team_messages_inbox
        ON team_messages(team_id, recipient_member_id, status, created_at);
    `);
  }

  async createTeam(input: TeamSnapshot): Promise<TeamSnapshot> {
    const team = TeamSnapshotSchema.parse(input);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.insertTeam(team);
      for (const member of team.members) this.insertMember(team.id, member);
      this.database.exec('COMMIT');
      return structuredClone(team);
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  async getTeam(id: string): Promise<TeamSnapshot | undefined> {
    const row = this.database.prepare('SELECT * FROM teams WHERE id = ?').get(id) as Row | undefined;
    if (!row) return undefined;
    const members = this.database.prepare('SELECT * FROM team_members WHERE team_id = ? ORDER BY id').all(id) as Row[];
    return TeamSnapshotSchema.parse({
      id: row.id,
      name: row.name,
      ...(optionalText(row.description) ? { description: row.description } : {}),
      workspace: row.workspace,
      workspaceKey: row.workspace_key,
      runtimeSessionId: row.runtime_session_id,
      maxConcurrency: row.max_concurrency,
      revision: row.revision,
      members: members.map(memberFromRow),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  }

  async listTeams(workspace?: string): Promise<TeamSnapshot[]> {
    const rows = (workspace
      ? this.database.prepare('SELECT id FROM teams WHERE workspace = ? ORDER BY name, id').all(workspace)
      : this.database.prepare('SELECT id FROM teams ORDER BY name, id').all()) as Row[];
    const teams = await Promise.all(rows.map((row) => this.getTeam(text(row.id, 'team_id'))));
    return teams.filter((team): team is TeamSnapshot => team !== undefined);
  }

  async updateTeam(input: TeamSnapshot): Promise<TeamSnapshot> {
    const team = TeamSnapshotSchema.parse(input);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const updated = this.database.prepare(`
        UPDATE teams SET name=?, description=?, workspace=?, workspace_key=?, runtime_session_id=?,
          max_concurrency=?, revision=?, updated_at=? WHERE id=?
      `).run(team.name, team.description ?? null, team.workspace, team.workspaceKey, team.runtimeSessionId,
        team.maxConcurrency, team.revision, team.updatedAt, team.id);
      if (updated.changes !== 1) throw new Error(`team_not_found: ${team.id}`);
      for (const member of team.members) this.upsertMember(team.id, member);
      const memberIds = team.members.map((member) => member.id);
      if (memberIds.length > 0) {
        const placeholders = memberIds.map(() => '?').join(',');
        this.database.prepare(
          `DELETE FROM team_members WHERE team_id = ? AND id NOT IN (${placeholders})`
        ).run(team.id, ...memberIds);
      }
      this.database.exec('COMMIT');
      return structuredClone(team);
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  async deleteTeam(id: string): Promise<void> {
    this.database.prepare('DELETE FROM teams WHERE id = ?').run(id);
  }

  async updateMember(teamId: string, member: TeamMemberSnapshot): Promise<TeamMemberSnapshot> {
    const result = this.database.prepare(`
      UPDATE team_members SET name=?, description=?, profile=?, provider_id=?, model=?, system_prompt=?,
        read_only=?, tool_policy_json=?, spawn_policy_json=?, lane_id=?, state=?, revision=?, updated_at=?
      WHERE team_id=? AND id=?
    `).run(
      member.name, member.description ?? null, member.profile, member.providerId ?? null,
      member.model ?? null, member.systemPrompt ?? null,
      member.readOnly === undefined ? null : member.readOnly ? 1 : 0,
      member.tools ? JSON.stringify(member.tools) : null,
      member.spawn ? JSON.stringify(member.spawn) : null,
      member.laneId, member.state, member.revision, member.updatedAt, teamId, member.id
    );
    if (result.changes !== 1) throw new Error(`team_member_not_found: ${teamId}/${member.id}`);
    return structuredClone(member);
  }

  async createTask(input: TeamTaskSnapshot): Promise<TeamTaskSnapshot> {
    const task = TeamTaskSnapshotSchema.parse(input);
    this.writeTask('INSERT', task);
    return structuredClone(task);
  }

  async getTask(id: string): Promise<TeamTaskSnapshot | undefined> {
    const row = this.database.prepare('SELECT * FROM team_tasks WHERE id = ?').get(id) as Row | undefined;
    return row ? taskFromRow(row) : undefined;
  }

  async listTasks(teamId: string, states?: TeamTaskState[]): Promise<TeamTaskSnapshot[]> {
    let rows: Row[];
    if (states?.length) {
      const placeholders = states.map(() => '?').join(',');
      rows = this.database.prepare(
        `SELECT * FROM team_tasks WHERE team_id = ? AND status IN (${placeholders}) ORDER BY created_at, id`
      ).all(teamId, ...states) as Row[];
    } else {
      rows = this.database.prepare('SELECT * FROM team_tasks WHERE team_id = ? ORDER BY created_at, id').all(teamId) as Row[];
    }
    return rows.map(taskFromRow);
  }

  async updateTask(input: TeamTaskSnapshot): Promise<TeamTaskSnapshot> {
    const task = TeamTaskSnapshotSchema.parse(input);
    this.writeTask('UPDATE', task);
    return structuredClone(task);
  }

  async enqueueMessage(input: TeamMessage): Promise<TeamMessage> {
    const message = TeamMessageSchema.parse(input);
    this.database.prepare(`
      INSERT INTO team_messages(id, team_id, sender_kind, sender_id, recipient_member_id,
        message_kind, subject, content, task_id, status, created_at, read_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(message.id, message.teamId, message.senderKind, message.senderId ?? null,
      message.recipientMemberId, message.kind, message.subject ?? null, message.content,
      message.taskId ?? null, message.status, message.createdAt, message.readAt ?? null);
    return structuredClone(message);
  }

  async getMessage(id: string): Promise<TeamMessage | undefined> {
    const row = this.database.prepare('SELECT * FROM team_messages WHERE id = ?').get(id) as Row | undefined;
    return row ? messageFromRow(row) : undefined;
  }

  async listInbox(input: { teamId: string; memberId?: string; includeRead?: boolean; limit?: number }): Promise<TeamMessage[]> {
    const where = ['team_id = ?'];
    const values: Array<string | number> = [input.teamId];
    if (input.memberId) {
      where.push('recipient_member_id = ?');
      values.push(input.memberId);
    }
    if (!input.includeRead) where.push("status = 'unread'");
    values.push(Math.min(500, Math.max(1, input.limit ?? 100)));
    const rows = this.database.prepare(
      `SELECT * FROM team_messages WHERE ${where.join(' AND ')} ORDER BY created_at, id LIMIT ?`
    ).all(...values) as Row[];
    return rows.map(messageFromRow);
  }

  async markMessageRead(id: string, readAt = new Date().toISOString()): Promise<void> {
    const result = this.database.prepare("UPDATE team_messages SET status='read', read_at=? WHERE id=?").run(readAt, id);
    if (result.changes !== 1) throw new Error(`team_message_not_found: ${id}`);
  }

  private insertTeam(team: TeamSnapshot): void {
    this.database.prepare(`
      INSERT INTO teams(id, name, description, workspace, workspace_key, runtime_session_id,
        max_concurrency, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(team.id, team.name, team.description ?? null, team.workspace, team.workspaceKey,
      team.runtimeSessionId, team.maxConcurrency, team.revision, team.createdAt, team.updatedAt);
  }

  private insertMember(teamId: string, member: TeamMemberSnapshot): void {
    this.database.prepare(`
      INSERT INTO team_members(id, team_id, name, description, profile, provider_id, model,
        system_prompt, read_only, tool_policy_json, spawn_policy_json, lane_id, state,
        revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(member.id, teamId, member.name, member.description ?? null, member.profile,
      member.providerId ?? null, member.model ?? null, member.systemPrompt ?? null,
      member.readOnly === undefined ? null : member.readOnly ? 1 : 0,
      member.tools ? JSON.stringify(member.tools) : null,
      member.spawn ? JSON.stringify(member.spawn) : null,
      member.laneId, member.state, member.revision, member.createdAt, member.updatedAt);
  }

  private upsertMember(teamId: string, member: TeamMemberSnapshot): void {
    this.database.prepare(`
      INSERT INTO team_members(id, team_id, name, description, profile, provider_id, model,
        system_prompt, read_only, tool_policy_json, spawn_policy_json, lane_id, state,
        revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(team_id, id) DO UPDATE SET
        name=excluded.name, description=excluded.description, profile=excluded.profile,
        provider_id=excluded.provider_id, model=excluded.model, system_prompt=excluded.system_prompt,
        read_only=excluded.read_only, tool_policy_json=excluded.tool_policy_json,
        spawn_policy_json=excluded.spawn_policy_json, lane_id=excluded.lane_id,
        state=excluded.state, revision=excluded.revision, updated_at=excluded.updated_at
    `).run(member.id, teamId, member.name, member.description ?? null, member.profile,
      member.providerId ?? null, member.model ?? null, member.systemPrompt ?? null,
      member.readOnly === undefined ? null : member.readOnly ? 1 : 0,
      member.tools ? JSON.stringify(member.tools) : null,
      member.spawn ? JSON.stringify(member.spawn) : null,
      member.laneId, member.state, member.revision, member.createdAt, member.updatedAt);
  }

  private writeTask(mode: 'INSERT' | 'UPDATE', task: TeamTaskSnapshot): void {
    const values = [
      task.teamId, task.memberId, task.parentSessionId ?? null, task.parentRunId ?? null,
      task.parentActorId ?? null, task.runtimeRunId ?? null, task.input, task.state,
      task.result ?? null, task.structuredResult === undefined ? null : JSON.stringify(task.structuredResult),
      task.schemaValid === undefined ? null : task.schemaValid ? 1 : 0,
      task.errorCode ?? null, task.error ?? null, task.stopReason ?? null, task.providerId, task.model,
      JSON.stringify(task.usage), task.incomplete ? 1 : 0,
      task.isolation ? JSON.stringify(task.isolation) : null,
      task.createdAt, task.startedAt ?? null, task.finishedAt ?? null
    ];
    if (mode === 'INSERT') {
      this.database.prepare(`
        INSERT INTO team_tasks(id, team_id, member_id, parent_session_id, parent_run_id,
          parent_actor_id, runtime_run_id, input, status, result, structured_result_json,
          schema_valid, error_code, error, stop_reason, provider_id, model, usage_json, incomplete,
          isolation_json, created_at, started_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(task.id, ...values);
      return;
    }
    const result = this.database.prepare(`
      UPDATE team_tasks SET team_id=?, member_id=?, parent_session_id=?, parent_run_id=?,
        parent_actor_id=?, runtime_run_id=?, input=?, status=?, result=?, structured_result_json=?,
        schema_valid=?, error_code=?, error=?, stop_reason=?, provider_id=?, model=?, usage_json=?, incomplete=?,
        isolation_json=?, created_at=?, started_at=?, finished_at=? WHERE id=?
    `).run(...values, task.id);
    if (result.changes !== 1) throw new Error(`team_task_not_found: ${task.id}`);
  }
}
