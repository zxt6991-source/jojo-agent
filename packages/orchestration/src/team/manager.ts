import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  TeamDefinitionSchema,
  type AgentEvent,
  type OrchestrationEvent,
  type TeamMemberSnapshot,
  type TeamMessage,
  type TeamSnapshot,
  type TeamTaskSnapshot,
  type TeamTaskState
} from '@desktop-agent/contracts';
import { abortError } from '../abort.js';
import { OrchestrationError } from '../errors.js';
import { IsolationManager } from '../isolation/manager.js';
import { withIsolationTask } from '../isolation/policy.js';
import type { IsolationContext } from '../isolation/types.js';
import { assertOutputSchema, validateStructuredOutput } from '../structured-output.js';
import { emptyUsage } from '../usage.js';
import type { OrchestratedAgentRunner } from '../agent/types.js';
import { AgentProfileRegistry, createBuiltinAgentProfileRegistry } from '../subagent/profile-registry.js';
import { ProviderSemaphore } from '../subagent/provider-semaphore.js';
import { acquireResourceAndAgentSlots, ResourceGroupLimiter } from '../subagent/resource-groups.js';
import { AgentExecutionScheduler } from '../subagent/scheduler.js';
import type { SubAgentManager } from '../subagent/manager.js';
import type { TeamStore } from './store.js';
import { resolveEffectiveAgentConfig } from './effective-config.js';
import { buildTeamMemberInstructions, buildTeamTaskPrompt } from './prompt.js';
import type {
  TeamCreateRequest,
  TeamDelegateRequest,
  TeamSendMessageRequest,
  TeamStatusSnapshot
} from './types.js';

const TERMINAL_TASK_STATES = new Set<TeamTaskState>(['completed', 'failed', 'cancelled', 'interrupted']);

type LiveTask = {
  controller: AbortController;
  done: Promise<void>;
  resolveDone: () => void;
};

export type TeamManagerOptions = {
  profileRegistry?: AgentProfileRegistry;
  isolation?: IsolationManager;
  resourceGroups?: ResourceGroupLimiter;
  providers?: ProviderSemaphore;
  subAgents?: SubAgentManager;
};

export class TeamManager {
  private readonly profileRegistry: AgentProfileRegistry;
  private readonly isolation: IsolationManager | undefined;
  private readonly resourceGroups: ResourceGroupLimiter;
  private readonly providers: ProviderSemaphore;
  private readonly subAgents: SubAgentManager | undefined;
  private readonly memberSchedulers = new Map<string, AgentExecutionScheduler>();
  private readonly liveTasks = new Map<string, LiveTask>();

  constructor(
    private readonly store: TeamStore,
    private readonly runner: OrchestratedAgentRunner,
    private readonly scheduler: AgentExecutionScheduler,
    private readonly emit: (event: OrchestrationEvent) => void,
    options: TeamManagerOptions = {}
  ) {
    this.profileRegistry = options.profileRegistry ?? createBuiltinAgentProfileRegistry();
    this.isolation = options.isolation;
    this.resourceGroups = options.resourceGroups ?? new ResourceGroupLimiter();
    this.providers = options.providers ?? new ProviderSemaphore();
    this.subAgents = options.subAgents;
  }

  async initialize(): Promise<void> {
    for (const team of await this.store.listTeams()) {
      this.resourceGroups.register({ group: this.teamGroup(team.id), maxConcurrency: team.maxConcurrency });
      const unsafe = await this.store.listTasks(team.id, ['running', 'waiting_approval']);
      for (const task of unsafe) {
        await this.finishPersistedTask(task, {
          state: 'interrupted',
          errorCode: 'team_runtime_failed',
          error: 'The previous process stopped while this task was active. It was not replayed to avoid duplicate side effects.'
        });
      }
      for (const task of await this.store.listTasks(team.id, ['queued'])) this.schedule(task);
    }
  }

  async create(input: TeamCreateRequest): Promise<TeamSnapshot> {
    const definition = TeamDefinitionSchema.parse(input);
    if (await this.store.getTeam(definition.id)) {
      throw new OrchestrationError('team_exists', `Team already exists: ${definition.id}`);
    }
    for (const member of definition.members) this.profileRegistry.get(member.profile, definition.workspace);
    const workspace = path.resolve(definition.workspace);
    const workspaceKey = createHash('sha256').update(workspace).digest('hex');
    const now = new Date().toISOString();
    const team: TeamSnapshot = {
      id: definition.id,
      name: definition.name,
      ...(definition.description ? { description: definition.description } : {}),
      workspace,
      workspaceKey,
      runtimeSessionId: `team:${workspaceKey.slice(0, 12)}:${definition.id}`,
      maxConcurrency: definition.maxConcurrency,
      revision: 1,
      members: definition.members.map((member) => ({
        ...structuredClone(member),
        laneId: `member:${member.id}`,
        state: 'idle',
        revision: 1,
        createdAt: member.id ? definition.createdAt ?? now : now,
        updatedAt: definition.updatedAt ?? now
      })),
      createdAt: definition.createdAt ?? now,
      updatedAt: definition.updatedAt ?? now
    };
    this.resourceGroups.register({ group: this.teamGroup(team.id), maxConcurrency: team.maxConcurrency });
    const created = await this.store.createTeam(team);
    this.emit({ type: 'team.changed', team: created });
    return created;
  }

  get(id: string): Promise<TeamSnapshot | undefined> { return this.store.getTeam(id); }
  list(workspace?: string): Promise<TeamSnapshot[]> { return this.store.listTeams(workspace); }

  async update(input: TeamCreateRequest, expectedRevision?: number): Promise<TeamSnapshot> {
    const definition = TeamDefinitionSchema.parse(input);
    const current = await this.requireTeam(definition.id);
    if (expectedRevision !== undefined && current.revision !== expectedRevision) {
      throw new OrchestrationError('team_store_failed', `Team changed since it was opened (expected revision ${expectedRevision}, got ${current.revision}).`);
    }
    for (const member of definition.members) this.profileRegistry.get(member.profile, definition.workspace);
    const nextIds = new Set(definition.members.map((member) => member.id));
    const removed = current.members.filter((member) => !nextIds.has(member.id));
    if (removed.length) {
      const active = await this.store.listTasks(current.id, ['queued', 'running', 'waiting_approval']);
      const busy = removed.find((member) => active.some((task) => task.memberId === member.id));
      if (busy) throw new OrchestrationError('team_member_busy', `Cannot remove active team member: ${busy.id}`);
    }
    const workspace = path.resolve(definition.workspace);
    const workspaceKey = createHash('sha256').update(workspace).digest('hex');
    const now = new Date().toISOString();
    const updated: TeamSnapshot = {
      ...current,
      name: definition.name,
      ...(definition.description ? { description: definition.description } : { description: undefined }),
      workspace,
      workspaceKey,
      runtimeSessionId: workspace === current.workspace
        ? current.runtimeSessionId
        : `team:${workspaceKey.slice(0, 12)}:${definition.id}`,
      maxConcurrency: definition.maxConcurrency,
      revision: current.revision + 1,
      members: definition.members.map((member) => {
        const existing = current.members.find((candidate) => candidate.id === member.id);
        return {
          ...structuredClone(member),
          laneId: existing?.laneId ?? `member:${member.id}`,
          state: existing?.state ?? 'idle',
          revision: (existing?.revision ?? 0) + 1,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now
        };
      }),
      updatedAt: now
    };
    if (!definition.description) delete updated.description;
    if (updated.maxConcurrency !== current.maxConcurrency) {
      this.resourceGroups.reconfigure({ group: this.teamGroup(updated.id), maxConcurrency: updated.maxConcurrency });
    }
    const stored = await this.store.updateTeam(updated);
    this.emit({ type: 'team.changed', team: stored });
    return stored;
  }

  async delete(id: string): Promise<void> {
    await this.requireTeam(id);
    for (const task of await this.store.listTasks(id, ['queued', 'running', 'waiting_approval'])) await this.cancel(task.id);
    await this.store.deleteTeam(id);
    this.emit({ type: 'team.deleted', teamId: id });
  }

  async delegate(request: TeamDelegateRequest): Promise<TeamTaskSnapshot> {
    const taskInput = request.task.trim();
    if (!taskInput) throw new OrchestrationError('invalid_input', 'Team task is required.');
    const team = await this.requireTeam(request.teamId);
    const member = this.requireMember(team, request.memberId);
    if (member.state === 'disabled') {
      throw new OrchestrationError('team_member_disabled', `Team member is disabled: ${member.id}`);
    }
    if (request.outputSchema) assertOutputSchema(request.outputSchema);
    const profile = this.profileRegistry.get(member.profile, team.workspace);
    const effective = resolveEffectiveAgentConfig({
      profile,
      member,
      ...(request.providerId ? { providerId: request.providerId } : {}),
      ...(request.model ? { model: request.model } : {}),
      ...(request.maxIterations !== undefined ? { maxIterations: request.maxIterations } : {}),
      ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {})
    });
    const task: TeamTaskSnapshot = {
      id: `tt_${crypto.randomUUID()}`,
      teamId: team.id,
      memberId: member.id,
      parentSessionId: request.parent.sessionId,
      ...(request.parent.runId ? { parentRunId: request.parent.runId } : {}),
      ...(request.parent.actorId ? { parentActorId: request.parent.actorId } : {}),
      input: taskInput,
      state: 'queued',
      providerId: effective.providerId,
      model: effective.model,
      usage: emptyUsage(),
      incomplete: false,
      createdAt: new Date().toISOString()
    };
    await this.store.createTask(task);
    await this.setMemberState(team, member, 'queued');
    this.emit({ type: 'team.task.changed', task });
    this.schedule(task, request);
    return structuredClone(task);
  }

  async wait(ids: string[], signal: AbortSignal, timeoutMs: number): Promise<TeamTaskSnapshot[]> {
    if (signal.aborted) throw abortError();
    const tasks = await Promise.all(ids.map(async (id) => {
      const task = await this.store.getTask(id);
      if (!task) throw new OrchestrationError('team_task_not_found', `Team task not found: ${id}`);
      return task;
    }));
    const waits = tasks.flatMap((task) => {
      if (TERMINAL_TASK_STATES.has(task.state)) return [];
      const live = this.liveTasks.get(task.id);
      return live ? [live.done] : [];
    });
    if (waits.length) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const interrupted = new Promise<void>((resolve, reject) => {
        timer = setTimeout(resolve, timeoutMs);
        onAbort = () => reject(abortError());
        signal.addEventListener('abort', onAbort, { once: true });
      });
      try { await Promise.race([Promise.all(waits).then(() => undefined), interrupted]); }
      finally {
        if (timer) clearTimeout(timer);
        if (onAbort) signal.removeEventListener('abort', onAbort);
      }
    }
    return Promise.all(ids.map(async (id) => (await this.store.getTask(id))!));
  }

  async cancel(id: string): Promise<TeamTaskSnapshot> {
    const task = await this.store.getTask(id);
    if (!task) throw new OrchestrationError('team_task_not_found', `Team task not found: ${id}`);
    if (TERMINAL_TASK_STATES.has(task.state)) return task;
    this.liveTasks.get(id)?.controller.abort('team_task_cancelled');
    this.subAgents?.cancelOwnedBy({ kind: 'team_member', id: task.memberId, teamId: task.teamId });
    return this.finishPersistedTask(task, { state: 'cancelled', stopReason: 'cancelled', incomplete: true });
  }

  async sendMessage(request: TeamSendMessageRequest): Promise<TeamMessage> {
    const team = await this.requireTeam(request.teamId);
    this.requireMember(team, request.memberId);
    const content = request.message.trim();
    if (!content) throw new OrchestrationError('invalid_input', 'Team message is required.');
    const message: TeamMessage = {
      id: `tm_${crypto.randomUUID()}`,
      teamId: team.id,
      senderKind: request.sender?.kind ?? 'main',
      ...(request.sender?.id ? { senderId: request.sender.id } : {}),
      recipientMemberId: request.memberId,
      kind: request.kind ?? 'note',
      ...(request.subject ? { subject: request.subject } : {}),
      content,
      ...(request.taskId ? { taskId: request.taskId } : {}),
      status: 'unread',
      createdAt: new Date().toISOString()
    };
    await this.store.enqueueMessage(message);
    this.emit({ type: 'team.message.created', message });
    return message;
  }

  listInbox(input: { teamId: string; memberId?: string; includeRead?: boolean; limit?: number }): Promise<TeamMessage[]> {
    return this.store.listInbox(input);
  }

  markMessageRead(id: string): Promise<void> { return this.store.markMessageRead(id); }

  async enableMember(teamId: string, memberId: string): Promise<TeamMemberSnapshot> {
    const team = await this.requireTeam(teamId);
    return this.setMemberState(team, this.requireMember(team, memberId), 'idle');
  }

  async disableMember(teamId: string, memberId: string): Promise<TeamMemberSnapshot> {
    const team = await this.requireTeam(teamId);
    const member = this.requireMember(team, memberId);
    const active = (await this.store.listTasks(teamId, ['queued', 'running', 'waiting_approval']))
      .filter((task) => task.memberId === memberId);
    for (const task of active) await this.cancel(task.id);
    return this.setMemberState(team, member, 'disabled');
  }

  async status(teamId: string): Promise<TeamStatusSnapshot> {
    const team = await this.requireTeam(teamId);
    const tasks = await this.store.listTasks(teamId);
    const unread = await this.store.listInbox({ teamId, limit: 500 });
    return {
      team,
      activeTasks: tasks.filter((task) => task.state === 'running' || task.state === 'waiting_approval'),
      queuedTasks: tasks.filter((task) => task.state === 'queued'),
      recentTasks: tasks.filter((task) => TERMINAL_TASK_STATES.has(task.state)).slice(-20).reverse(),
      unreadMessages: unread.length
    };
  }

  private schedule(task: TeamTaskSnapshot, request?: TeamDelegateRequest): void {
    if (this.liveTasks.has(task.id)) return;
    const controller = new AbortController();
    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    this.liveTasks.set(task.id, { controller, done, resolveDone });
    void this.execute(task, controller, request).finally(() => {
      this.liveTasks.get(task.id)?.resolveDone();
      this.liveTasks.delete(task.id);
    });
  }

  private async execute(task: TeamTaskSnapshot, controller: AbortController, request?: TeamDelegateRequest): Promise<void> {
    let releaseMember: (() => void) | undefined;
    let releaseResources: (() => void) | undefined;
    let isolation: IsolationContext | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let team: TeamSnapshot | undefined;
    let member: TeamMemberSnapshot | undefined;
    try {
      team = await this.requireTeam(task.teamId);
      member = this.requireMember(team, task.memberId);
      const profile = this.profileRegistry.get(member.profile, team.workspace);
      const effective = resolveEffectiveAgentConfig({
        profile,
        member,
        providerId: task.providerId,
        model: task.model,
        ...(request?.maxIterations !== undefined ? { maxIterations: request.maxIterations } : {}),
        ...(request?.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {})
      });
      releaseMember = await this.memberScheduler(team.id, member.id).acquire(controller.signal);
      releaseResources = await acquireResourceAndAgentSlots({
        resourceGroups: this.resourceGroups,
        resources: { group: this.teamGroup(team.id), maxConcurrency: team.maxConcurrency },
        providers: this.providers,
        providerId: effective.providerId,
        scheduler: this.scheduler,
        signal: controller.signal
      });
      if (controller.signal.aborted) throw abortError();
      const startedAt = new Date().toISOString();
      task = await this.store.updateTask({ ...task, state: 'running', startedAt });
      member = await this.setMemberState(team, member, 'running');
      this.emit({ type: 'team.task.changed', task });
      if (!effective.readOnly) {
        if (!this.isolation) throw new OrchestrationError('worktree_create_failed', 'Worktree isolation is not configured.');
        isolation = await this.isolation.prepare({
          ownerId: task.id,
          sessionId: team.runtimeSessionId,
          workingDirectory: team.workspace,
          branchHint: `${team.id}-${member.id}-${task.id}`
        });
      }
      const inbox = await this.store.listInbox({ teamId: team.id, memberId: member.id, limit: 20 });
      timer = setTimeout(() => controller.abort('timeout'), effective.timeoutMs);
      const result = await this.runner.run({
        id: member.id,
        sessionId: team.runtimeSessionId,
        laneId: member.laneId,
        parentLaneId: 'main',
        workingDirectory: isolation?.workingDirectory ?? team.workspace,
        task: withIsolationTask(buildTeamTaskPrompt(task.input, inbox), isolation),
        actor: {
          kind: 'team_member', id: member.id, profile: member.profile,
          teamId: team.id, memberId: member.id, taskId: task.id
        },
        profile: member.profile,
        providerId: effective.providerId,
        model: effective.model,
        maxIterations: effective.maxIterations,
        timeoutMs: effective.timeoutMs,
        ...(member.tools ? { tools: member.tools } : {}),
        ...(effective.readOnly ? { readOnly: true } : {}),
        ...(request?.outputSchema ? { outputSchema: request.outputSchema } : {}),
        ...(request?.memoryBinding ? { memoryBinding: request.memoryBinding } : {}),
        additionalInstructions: [
          buildTeamMemberInstructions(team, member),
          ...(effective.systemPrompt ? [effective.systemPrompt] : [])
        ]
      }, controller.signal, (event) => this.onAgentEvent(task, team!, member!, event));
      for (const message of inbox) await this.store.markMessageRead(message.id);
      const isolationSnapshot = isolation ? await this.isolation!.finish(isolation) : undefined;
      isolation = undefined;
      let update: Partial<TeamTaskSnapshot> = {
        state: result.stopReason === 'cancelled' ? 'cancelled' : 'completed',
        result: result.result,
        stopReason: result.stopReason,
        runtimeRunId: result.runId,
        usage: result.usage,
        incomplete: result.incomplete,
        ...(isolationSnapshot ? { isolation: isolationSnapshot } : {})
      };
      if (request?.outputSchema) {
        const structured = validateStructuredOutput(result.result, request.outputSchema);
        update = structured.ok
          ? { ...update, structuredResult: structured.value, schemaValid: true }
          : { ...update, state: 'failed', schemaValid: false, errorCode: structured.code, error: structured.message, incomplete: true };
      }
      const current = await this.store.getTask(task.id);
      if (current && !TERMINAL_TASK_STATES.has(current.state)) await this.finishPersistedTask(current, update);
    } catch (error) {
      const current = await this.store.getTask(task.id) ?? task;
      if (!TERMINAL_TASK_STATES.has(current.state)) {
        await this.finishPersistedTask(current, controller.signal.aborted
          ? { state: controller.signal.reason === 'timeout' ? 'failed' : 'cancelled', stopReason: String(controller.signal.reason ?? 'cancelled'), incomplete: true }
          : {
              state: 'failed', errorCode: error instanceof OrchestrationError ? error.code : 'team_runtime_failed',
              error: error instanceof Error ? error.message : String(error), incomplete: true
            });
      }
    } finally {
      if (timer) clearTimeout(timer);
      if (isolation && this.isolation) await this.isolation.finish(isolation).catch(() => undefined);
      if (team && member) {
        const latestTeam = await this.store.getTeam(team.id);
        const latestMember = latestTeam?.members.find((candidate) => candidate.id === member!.id);
        if (latestTeam && latestMember && latestMember.state !== 'disabled') {
          await this.setMemberState(latestTeam, latestMember, 'idle').catch(() => undefined);
        }
      }
      releaseResources?.();
      releaseMember?.();
    }
  }

  private onAgentEvent(task: TeamTaskSnapshot, team: TeamSnapshot, member: TeamMemberSnapshot, event: AgentEvent): void {
    if (event.type !== 'approval.required') return;
    void this.store.getTask(task.id).then(async (current) => {
      if (!current || TERMINAL_TASK_STATES.has(current.state)) return;
      const waiting = await this.store.updateTask({ ...current, state: 'waiting_approval' });
      this.emit({ type: 'team.task.changed', task: waiting });
      await this.setMemberState(team, member, 'waiting_approval');
    }).catch(() => undefined);
  }

  private async finishPersistedTask(task: TeamTaskSnapshot, update: Partial<TeamTaskSnapshot>): Promise<TeamTaskSnapshot> {
    const finished: TeamTaskSnapshot = {
      ...task,
      ...update,
      finishedAt: new Date().toISOString()
    };
    const stored = await this.store.updateTask(finished);
    this.emit({ type: 'team.task.changed', task: stored });
    return stored;
  }

  private async setMemberState(
    team: TeamSnapshot,
    member: TeamMemberSnapshot,
    state: TeamMemberSnapshot['state']
  ): Promise<TeamMemberSnapshot> {
    if (member.state === state) return member;
    const updated: TeamMemberSnapshot = {
      ...member,
      state,
      revision: member.revision + 1,
      updatedAt: new Date().toISOString()
    };
    await this.store.updateMember(team.id, updated);
    this.emit({ type: 'team.member.changed', teamId: team.id, member: updated });
    return updated;
  }

  private async requireTeam(id: string): Promise<TeamSnapshot> {
    const team = await this.store.getTeam(id);
    if (!team) throw new OrchestrationError('team_not_found', `Team not found: ${id}`);
    return team;
  }

  private requireMember(team: TeamSnapshot, id: string): TeamMemberSnapshot {
    const member = team.members.find((candidate) => candidate.id === id);
    if (!member) throw new OrchestrationError('team_member_not_found', `Team member not found: ${team.id}/${id}`);
    return member;
  }

  private teamGroup(teamId: string): string {
    return `team-${createHash('sha256').update(teamId).digest('hex').slice(0, 24)}`;
  }

  private memberScheduler(teamId: string, memberId: string): AgentExecutionScheduler {
    const key = `${teamId}:${memberId}`;
    const existing = this.memberSchedulers.get(key);
    if (existing) return existing;
    const created = new AgentExecutionScheduler(1);
    this.memberSchedulers.set(key, created);
    return created;
  }
}
