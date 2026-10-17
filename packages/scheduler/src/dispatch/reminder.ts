import type { ReminderScheduleTarget } from '../types.js';
import type {
  ScheduleDispatchRequest,
  TargetExecutionEvent,
  TargetExecutionReference,
  TargetExecutionSnapshot,
  TypedScheduleTargetDispatcher
} from './dispatcher.js';

/** A deterministic target: recovery may repeat dispatch, but never creates a model run. */
export class ReminderScheduleDispatcher implements TypedScheduleTargetDispatcher<ReminderScheduleTarget> {
  readonly kind = 'reminder' as const;
  readonly idempotent = true;
  private readonly completed = new Map<string, TargetExecutionSnapshot>();

  async dispatch(input: ScheduleDispatchRequest<ReminderScheduleTarget>): Promise<TargetExecutionSnapshot> {
    const text = input.target.text.trim();
    if (!text || text.length > 200) throw new Error('schedule_target_invalid: Reminder text must contain 1–200 characters.');
    const existing = this.completed.get(input.executionId);
    if (existing) return { ...existing };
    const result: TargetExecutionSnapshot = {
      kind: 'reminder', id: input.executionId, state: 'completed', resultPreview: text
    };
    this.completed.set(result.id, result);
    while (this.completed.size > 1_000) {
      const oldest = this.completed.keys().next().value;
      if (oldest === undefined) break;
      this.completed.delete(oldest);
    }
    return { ...result };
  }

  async inspect(reference: TargetExecutionReference): Promise<TargetExecutionSnapshot | undefined> {
    const result = this.completed.get(reference.id);
    return result ? { ...result } : undefined;
  }

  async cancel(_reference: TargetExecutionReference): Promise<void> {}
  subscribe(_listener: (event: TargetExecutionEvent) => void): () => void { return () => undefined; }
  close(): void { this.completed.clear(); }
}
