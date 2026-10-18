import type { AgentEvent } from '@desktop-agent/contracts';

export const VOICE_RESPONSE_INSTRUCTIONS = `你当前处于语音交互模式。优先用短句和自然口语，技术结论先说结果。不复述完整问题，不使用固定的“首先、其次、最后”模板。屏幕保留完整细节，口语只给一句结论和必要提醒。不要朗读代码、diff、Markdown 表格、长列表、完整路径或命令输出；必要时只说文件名。信息不足时直接问关键条件。工具执行中只陈述真实发生的动作，不能虚构检查、修改或完成进度。停止说话只停止语音，只有用户明确取消任务时才按 Runtime 策略取消任务。`;

export class CodingProgressNarrator {
  private lastAt = -Infinity;
  private lastKind = '';
  private readonly active = new Map<string, string>();
  constructor(private readonly minIntervalMs = 8000) {}
  onEvent(event: AgentEvent, now: number): string | undefined {
    if (event.type === 'tool.finished') { this.active.delete(event.id); return undefined; }
    if (event.type !== 'tool.started') return undefined;
    const kind = /(?:read_file|file_read)/u.test(event.name) ? 'read'
      : /(?:search|grep|glob|list_files)/u.test(event.name) ? 'search'
      : /(?:terminal|command|shell|exec)/u.test(event.name) ? 'command' : '';
    this.active.set(event.id, kind);
    if (!kind || now - this.lastAt < this.minIntervalMs || kind === this.lastKind) return undefined;
    this.lastAt = now; this.lastKind = kind;
    return kind === 'read' ? '我看一下相关文件。' : kind === 'search' ? '我搜一下相关实现。' : '我运行一下命令，看看结果。';
  }
  reset(): void { this.active.clear(); this.lastAt = -Infinity; this.lastKind = ''; }
}
