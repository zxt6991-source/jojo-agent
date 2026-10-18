import { randomUUID } from 'node:crypto';
import type { SpeechControl, WorkerCommand, WorkerMessage } from '@desktop-agent/contracts';

export class SpeechRpcClient {
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private readonly post: (command: WorkerCommand) => void) {}
  request(control: SpeechControl): Promise<unknown> {
    if (this.pending.size >= 32) return Promise.reject(new Error('语音请求过多，请稍后重试。'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      // Neural cold start and at most two smaller-span retries have their own
      // bounded process deadlines. A shorter IPC timeout must not orphan them.
      const timeoutMs = control.action === 'readMessage' ? 550_000 : control.action === 'test' ? 185_000 : 45_000;
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('语音请求超时，请查询状态或重试。')); }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.post({ type: 'speech.control', requestId, control }); }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }
  accept(message: Extract<WorkerMessage, { type: 'speech.result' }>): void {
    const request = this.pending.get(message.requestId);
    if (!request) return;
    clearTimeout(request.timer); this.pending.delete(message.requestId);
    if (message.ok) request.resolve(message.result);
    else request.reject(new Error(message.error ?? '语音请求失败。'));
  }
  close(): void {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('语音运行进程已结束。')); }
    this.pending.clear();
  }
}
