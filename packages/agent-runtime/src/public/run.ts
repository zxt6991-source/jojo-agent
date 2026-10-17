import type {
  AgentEvent
} from '@desktop-agent/contracts';
import type { RunResult, RuntimeInput } from '@desktop-agent/contracts/runtime';
import { VoiceTurnMetadataSchema, type VoiceTurnMetadata } from '@desktop-agent/contracts';

export type RuntimeVoiceContext = VoiceTurnMetadata;
/** Redacted boundary validation before App Service or Runtime persists metadata. */
export function parseRuntimeVoiceContext(value: unknown): RuntimeVoiceContext {
  const parsed = VoiceTurnMetadataSchema.safeParse(value);
  if (!parsed.success) throw Object.assign(new Error('runtime_voice_context_invalid'), { code: 'runtime_voice_context_invalid' });
  return parsed.data;
}

export type RunBudget = {
  maxIterations?: number;
  allowPartialOnLimit?: boolean;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
};

export type RuntimeActor = {
  kind: 'main' | 'subagent' | 'workflow' | 'team_member' | 'channel_user';
  id?: string;
  profile?: string;
};

export type RuntimeTriggerContext = {
  kind: 'user' | 'api' | 'scheduler' | 'workflow' | 'subagent' | 'team_member' | 'resume' | 'channel_message';
  id?: string;
};

export type RuntimeWorkflowContext = {
  id: string;
  runId?: string;
  stepId?: string;
};

export type RuntimeTeamContext = {
  id: string;
  memberId: string;
  taskId?: string;
};

export type RunRequest = {
  /** Stable public identity supplied by durable orchestrators before execution starts. */
  runId?: string;
  /** Strings remain accepted during the v0.x compatibility window. */
  input: RuntimeInput | string;
  providerId: string;
  model: string;
  instructions?: string[];
  budget?: RunBudget;
  actor?: RuntimeActor;
  trigger?: RuntimeTriggerContext;
  workflow?: RuntimeWorkflowContext;
  team?: RuntimeTeamContext;
  voice?: RuntimeVoiceContext;
  signal?: AbortSignal;
};

export interface RunHandle {
  readonly id: string;
  readonly result: Promise<RunResult>;
  cancel(reason?: string): Promise<void>;
}

/** Diagnostic compatibility channel; stable consumers should subscribe to RuntimeEventEnvelope. */
export interface TelemetrySink {
  diagnostic(event: AgentEvent, context: {
    sessionId: string;
    laneId: string;
    runId: string;
    actor?: RuntimeActor;
    trigger?: RuntimeTriggerContext;
    workflow?: RuntimeWorkflowContext;
    team?: RuntimeTeamContext;
  }): void;
}

export type { RuntimeInput, RuntimeInputBlock } from '@desktop-agent/contracts/runtime';
