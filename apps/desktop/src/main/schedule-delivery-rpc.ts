import { randomUUID } from 'node:crypto';
import type { ScheduleDeliveryControl, WorkerCommand, WorkerMessage } from '@desktop-agent/contracts';

/** A short deadline keeps a lost Worker lease from authorizing sound. */
export class ScheduleDeliveryRpc {
  private readonly pending = new Map<string, { resolve(value: boolean): void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private readonly post: (command: WorkerCommand) => void) {}
  request(control: ScheduleDeliveryControl): Promise<boolean> {
    if (this.pending.size >= 32) return Promise.resolve(false);
    const requestId = randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pending.delete(requestId); resolve(false); }, 5_000);
      this.pending.set(requestId, { resolve, timer });
      try { this.post({ type: 'scheduler.delivery.control', requestId, control }); }
      catch { clearTimeout(timer); this.pending.delete(requestId); resolve(false); }
    });
  }
  accept(message: Extract<WorkerMessage, { type: 'scheduler.delivery.result' }>): void {
    const request = this.pending.get(message.requestId);
    if (!request) return;
    clearTimeout(request.timer); this.pending.delete(message.requestId); request.resolve(message.ok);
  }
  close(): void {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.resolve(false); }
    this.pending.clear();
  }
}
