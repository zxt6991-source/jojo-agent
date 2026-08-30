import type { ScheduleEvent } from './types.js';

export class ScheduleEventBus {
  private readonly listeners = new Set<(event: ScheduleEvent) => void>();

  subscribe(listener: (event: ScheduleEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: ScheduleEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* Observers never change scheduler behavior. */ }
    }
  }

  clear(): void { this.listeners.clear(); }
}
