import type { Schedule, ScheduleRun, ScheduleTarget } from '../types.js';

export type TargetExecutionState =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type TargetExecutionSnapshot = {
  kind: ScheduleTarget['kind'];
  id: string;
  state: TargetExecutionState;
  resultPreview?: string;
  errorCode?: string;
  error?: string;
};

export type TargetExecutionReference = {
  kind: ScheduleTarget['kind'];
  id: string;
};

export type ScheduleDispatchRequest<TTarget extends ScheduleTarget = ScheduleTarget> = {
  schedule: Schedule;
  run: ScheduleRun;
  target: TTarget;
  executionId: string;
};

export type TargetExecutionEvent = { snapshot: TargetExecutionSnapshot };

export interface ScheduleTargetDispatcher {
  dispatch(input: ScheduleDispatchRequest): Promise<TargetExecutionSnapshot>;
  inspect(reference: TargetExecutionReference): Promise<TargetExecutionSnapshot | undefined>;
  cancel(reference: TargetExecutionReference): Promise<void>;
  supportsIdempotentDispatch(kind: ScheduleTarget['kind']): boolean;
  subscribe(listener: (event: TargetExecutionEvent) => void): () => void;
}

export interface TypedScheduleTargetDispatcher<TTarget extends ScheduleTarget = ScheduleTarget> {
  readonly kind: TTarget['kind'];
  readonly idempotent: boolean;
  dispatch(input: ScheduleDispatchRequest<TTarget>): Promise<TargetExecutionSnapshot>;
  inspect(reference: TargetExecutionReference): Promise<TargetExecutionSnapshot | undefined>;
  cancel(reference: TargetExecutionReference): Promise<void>;
  subscribe(listener: (event: TargetExecutionEvent) => void): () => void;
}
