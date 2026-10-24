import {
  ConversationMapCancelInputSchema, ConversationMapGenerateInputSchema,
  ConversationMapSourceInputSchema, IPC, type ConversationMapEvent,
  type ConversationMapSourceResult, type WorkerCommand, type WorkerMessage
} from '@desktop-agent/contracts';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';

/** A single trusted settings surface owns one bounded, cancellable analysis. */
export class ConversationMapIpc {
  private active: { id: string; timer: ReturnType<typeof setTimeout> } | undefined;
  private sources = new Map<string, { resolve(value: ConversationMapSourceResult): void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private readonly ctx: {
    post(command: WorkerCommand): boolean;
    emit(event: ConversationMapEvent): void;
    assertTrusted(event: IpcMainInvokeEvent): void;
  }) {}

  private post(command: WorkerCommand): boolean {
    try { return this.ctx.post(command); } catch { return false; }
  }

  register(ipc: Pick<IpcMain, 'handle'>): void {
    ipc.handle(IPC.generateConversationMap, (event, raw) => {
      this.ctx.assertTrusted(event);
      const input = ConversationMapGenerateInputSchema.parse(raw);
      if (this.active) throw new Error('已有脉络生成任务，请先取消。');
      const timer = setTimeout(() => this.stop('生成超时，请缩小范围后重试。'), 10 * 60_000);
      this.active = { id: input.requestId, timer };
      if (!this.post({ type: 'conversation-map.generate', input })) {
        clearTimeout(timer); this.active = undefined;
        throw new Error('分析进程尚未就绪，请稍后重试。');
      }
    });
    ipc.handle(IPC.cancelConversationMap, (event, raw) => {
      this.ctx.assertTrusted(event);
      const { requestId } = ConversationMapCancelInputSchema.parse(raw);
      if (this.active?.id === requestId) this.stop();
      else this.post({ type: 'conversation-map.cancel', requestId });
    });
    ipc.handle(IPC.getConversationMapSource, (event, raw) => {
      this.ctx.assertTrusted(event);
      const input = ConversationMapSourceInputSchema.parse(raw);
      if (this.sources.size >= 24) throw new Error('出处请求过多，请稍后重试。');
      const requestId = randomUUID();
      return new Promise<ConversationMapSourceResult>(resolve => {
        const timer = setTimeout(() => { this.sources.delete(requestId); resolve({ available: false }); }, 15_000);
        this.sources.set(requestId, { resolve, timer });
        if (!this.post({ type: 'conversation-map.source', requestId, input })) {
          clearTimeout(timer); this.sources.delete(requestId); resolve({ available: false });
        }
      });
    });
  }

  accept(message: WorkerMessage): boolean {
    if (message.type === 'conversation-map.source.result') {
      const request = this.sources.get(message.requestId);
      if (request) { clearTimeout(request.timer); this.sources.delete(message.requestId); request.resolve(message.result); }
      return true;
    }
    if (message.type !== 'conversation-map.event') return false;
    if (this.active?.id !== message.event.requestId) return true;
    if (message.event.type !== 'conversation-map.progress') {
      clearTimeout(this.active.timer); this.active = undefined;
    }
    this.ctx.emit(message.event);
    return true;
  }

  stop(message?: string): void {
    const active = this.active;
    if (active) {
      clearTimeout(active.timer); this.active = undefined;
      this.post({ type: 'conversation-map.cancel', requestId: active.id });
      this.ctx.emit(message
        ? { type: 'conversation-map.failed', requestId: active.id, code: 'runtime_unavailable', message }
        : { type: 'conversation-map.cancelled', requestId: active.id });
    }
    for (const request of this.sources.values()) { clearTimeout(request.timer); request.resolve({ available: false }); }
    this.sources.clear();
  }
}
