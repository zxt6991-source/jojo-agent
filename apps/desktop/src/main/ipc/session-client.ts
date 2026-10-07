import type { WorkerCommand, WorkerMessage } from '@desktop-agent/contracts';
import { SessionMetadataResultSchema, type SessionMetadataOperation, type SessionMetadataResult } from '@desktop-agent/contracts/application';

/** Request ownership stays in Main; all metadata operations execute in Worker. */
export class SessionMetadataClient {
  private closing = false;
  private readonly pending = new Map<string, { resolve(result: SessionMetadataResult): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private readonly send: (command: WorkerCommand) => boolean, private readonly timeoutMs = 30_000) { }
  request(operation: SessionMetadataOperation): Promise<SessionMetadataResult> {
    if (this.closing) return Promise.reject(Object.assign(new Error('runtime_closing'), { code: 'runtime_closing' }));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('Session metadata request timed out.')); }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        if (!this.send({ type: 'session.metadata', requestId, operation })) throw new Error('Agent runtime is not available.');
      } catch (error) { this.finish(requestId, error instanceof Error ? error : new Error(String(error))); }
    });
  }
  accept(message: Extract<WorkerMessage, { type: 'session.metadata.result' }>): void {
    if (!message.ok) return this.finish(message.requestId, new Error(message.error ?? 'Session metadata request failed.'));
    const result = SessionMetadataResultSchema.safeParse(message.result);
    if (!result.success) return this.finish(message.requestId, new Error('Invalid session metadata response.'));
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId); clearTimeout(pending.timer); pending.resolve(result.data);
  }
  close(error = new Error('Agent runtime exited.'), permanently = false): void {
    this.closing ||= permanently;
    for (const id of this.pending.keys()) this.finish(id, error);
  }
  async get(sessionId: string) {
    const result = await this.request({ action: 'get', sessionId });
    if (Array.isArray(result)) throw new Error('Invalid session metadata response.');
    return result;
  }
  async list() {
    const result = await this.request({ action: 'list' });
    if (!Array.isArray(result)) throw new Error('Invalid session metadata response.');
    return result;
  }
  private finish(id: string, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id); clearTimeout(pending.timer); pending.reject(error);
  }
}
