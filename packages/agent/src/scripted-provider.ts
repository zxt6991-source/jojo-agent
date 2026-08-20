import type { ModelEvent, ModelProvider } from '@desktop-agent/contracts';

export class ScriptedProvider implements ModelProvider {
  private index = 0;

  constructor(private readonly scripts: ModelEvent[][]) {}

  async *stream(): AsyncIterable<ModelEvent> {
    const script = this.scripts[this.index++] ?? [];
    for (const event of script) yield event;
  }
}
