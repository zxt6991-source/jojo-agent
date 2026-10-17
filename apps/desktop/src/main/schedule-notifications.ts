import { Notification } from 'electron';
import type { ScheduleDesktopDelivery, ScheduleDesktopOutcome } from '@desktop-agent/contracts';

/** Notification receipt means the OS accepted it, never that a person read it. */
export class ScheduleNotificationHost {
  private readonly active = new Set<Notification>();
  constructor(private readonly showWindow: () => void, private readonly e2e = false) {}
  async deliver(input: Extract<ScheduleDesktopDelivery, { kind: 'notification' }>): Promise<ScheduleDesktopOutcome> {
    const identity = input.identity;
    if (input.expiresAt && Date.parse(input.expiresAt) <= Date.now()) return { identity, state: 'suppressed', errorCode: 'delivery_expired' };
    if (this.e2e) return { identity, state: 'delivered' };
    if (!Notification.isSupported() || this.active.size >= 100) return { identity, state: 'failed', errorCode: 'notification_unavailable' };
    return new Promise(resolve => {
      const notification = new Notification({ title: input.title, body: '定时任务已到，请打开 Jojo 查看结果。', silent: true });
      this.active.add(notification);
      let finished = false;
      const finish = (state: ScheduleDesktopOutcome['state'], errorCode?: string) => {
        if (finished) return;
        finished = true; clearTimeout(timer);
        resolve({ identity, state, ...(errorCode ? { errorCode } : {}) });
      };
      const timer = setTimeout(() => { notification.close(); finish('failed', 'notification_timeout'); }, 5_000);
      notification.once('show', () => finish('delivered'));
      notification.once('failed', () => { this.active.delete(notification); finish('failed', 'notification_failed'); });
      notification.once('close', () => this.active.delete(notification));
      notification.on('click', this.showWindow);
      try { notification.show(); } catch { this.active.delete(notification); finish('failed', 'notification_failed'); }
    });
  }
  close(): void { for (const notification of this.active) notification.close(); this.active.clear(); }
}
