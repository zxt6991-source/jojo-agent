import type { ScheduleTarget } from '../types.js';
import type {
  ScheduleDispatchRequest,
  ScheduleTargetDispatcher,
  TargetExecutionEvent,
  TargetExecutionReference,
  TargetExecutionSnapshot,
  TypedScheduleTargetDispatcher
} from './dispatcher.js';

export class ScheduleDispatcherRegistry implements ScheduleTargetDispatcher {
  private readonly dispatchers = new Map<ScheduleTarget['kind'], TypedScheduleTargetDispatcher>();
  private readonly listeners = new Set<(event: TargetExecutionEvent) => void>();
  private readonly unsubscribers = new Map<ScheduleTarget['kind'], () => void>();

  register<TTarget extends ScheduleTarget>(dispatcher: TypedScheduleTargetDispatcher<TTarget>): void {
    this.unsubscribers.get(dispatcher.kind)?.();
    this.dispatchers.set(dispatcher.kind, dispatcher as TypedScheduleTargetDispatcher);
    this.unsubscribers.set(dispatcher.kind, dispatcher.subscribe((event) => this.emit(event)));
  }

  async dispatch(input: ScheduleDispatchRequest): Promise<TargetExecutionSnapshot> {
    const dispatcher = this.require(input.target.kind);
    return dispatcher.dispatch(input);
  }

  inspect(reference: TargetExecutionReference): Promise<TargetExecutionSnapshot | undefined> {
    return this.require(reference.kind).inspect(reference);
  }

  cancel(reference: TargetExecutionReference): Promise<void> {
    return this.require(reference.kind).cancel(reference);
  }

  supportsIdempotentDispatch(kind: ScheduleTarget['kind']): boolean {
    return this.dispatchers.get(kind)?.idempotent ?? false;
  }

  subscribe(listener: (event: TargetExecutionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    for (const unsubscribe of this.unsubscribers.values()) unsubscribe();
    this.unsubscribers.clear();
    this.listeners.clear();
  }

  private require(kind: ScheduleTarget['kind']): TypedScheduleTargetDispatcher {
    const dispatcher = this.dispatchers.get(kind);
    if (!dispatcher) throw new Error(`schedule_target_invalid: No dispatcher registered for ${kind}.`);
    return dispatcher;
  }

  private emit(event: TargetExecutionEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* Observers are isolated. */ }
    }
  }
}
