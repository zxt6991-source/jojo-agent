import type {
  TeamDefinition,
  TeamMemberMemoryBinding,
  TeamMessageKind
} from '@desktop-agent/contracts';

export type TeamCreateRequest = TeamDefinition;

export type TeamDelegateRequest = {
  taskId?: string;
  teamId: string;
  memberId: string;
  task: string;
  parent: { sessionId: string; runId?: string; actorId?: string };
  providerId?: string;
  model?: string;
  timeoutMs?: number;
  maxIterations?: number;
  outputSchema?: Record<string, unknown>;
  memoryBinding?: TeamMemberMemoryBinding;
};

export type TeamSendMessageRequest = {
  teamId: string;
  memberId: string;
  message: string;
  kind?: Extract<TeamMessageKind, 'note' | 'question' | 'result' | 'system'>;
  subject?: string;
  taskId?: string;
  sender?: { kind: 'main' | 'team_member' | 'system'; id?: string };
};

export type TeamStatusSnapshot = import('@desktop-agent/contracts').TeamStatusSnapshot;
