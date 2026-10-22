import { describe, expect, it } from 'vitest';
import { VoiceTextProjector, projectVoiceReply } from '../src/voice-text-projector';
import { VoiceChunkScheduler } from '../src/voice-chunk-scheduler';
import { VoiceDeliveryLedger, interruptedVoiceContext } from '../src/voice-delivery-ledger';
import { CodingProgressNarrator } from '../src/coding-progress-narrator';

describe('stateful oral projection', () => {
  it('holds incomplete constructs and strips code across arbitrary delta boundaries', () => {
    const source = '改好了。\n```ts\nconsole.log("秘密。")\n```\n请看[测试结果](https://example.com/a)。路径 packages/speech/src/a.ts 留在屏幕。';
    const whole = new VoiceTextProjector();
    const expected = [...whole.append(source), ...whole.finish()];
    for (let split = 0; split <= source.length; split++) {
      const projector = new VoiceTextProjector();
      const projected = [...projector.append(source.slice(0, split)), ...projector.append(source.slice(split)), ...projector.finish()];
      expect(projected).toEqual(expected);
    }
    expect(expected.map(value => value.text).join(' ')).toBe('改好了。 请看测试结果。 路径 留在屏幕。');
  });
  it('does not leak unfinished fences or links at final', () => {
    const p = new VoiceTextProjector();
    expect(p.append('已经完成。\n```diff\n+ secret')).toHaveLength(1);
    expect(p.finish()).toEqual([]);
    expect(projectVoiceReply('```json\n{"key":"secret"}')).toBe('结果已经放在屏幕上了，请查看具体内容。');
    const link = new VoiceTextProjector();
    expect(link.append('[结果](https://example.com')).toEqual([]);
    expect(link.finish()).toEqual([]);
  });
  it('summarizes automatic reading while leaving full screen text untouched', () => {
    const text = '已经修复播放问题。测试通过。第三句细节。';
    expect(projectVoiceReply(text)).toBe('已经修复播放问题。 测试通过。');
    expect(text).toContain('第三句');
  });
  it('releases the first weak boundary without cutting a number, date or incomplete link', () => {
    const p = new VoiceTextProjector(); p.append('我先看看现在的实现，然后确认 2026/10/17 的结果');
    expect(p.flushWeakBoundary().map(value => value.text)).toEqual(['我先看看现在的实现，']);
    expect(p.finish()[0]?.text).toBe('然后确认 2026/10/17 的结果');
    const link = new VoiceTextProjector(); link.append('[这是一条较长的链接，内容未结束'); expect(link.flushWeakBoundary()).toEqual([]);
  });
  it('filters unfenced JSON and diff bodies across lines', () => {
    const p = new VoiceTextProjector();
    const text = '{\n"message": "不要朗读。",\n"key": 1\n}\ndiff --git a/x.ts b/x.ts\nindex abc..def\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n+console.log("不要朗读。");\n\n已经改好。';
    expect([...p.append(text), ...p.finish()].map(phrase => phrase.text)).toEqual(['已经改好。']);
  });
});

describe('consumer driven scheduler', () => {
  it('coalesces available sentences with their source span and waits while the consumer has enough audio', () => {
    const s = new VoiceChunkScheduler();
    s.append([{ text: '第一句。', sourceTextRange: { start: 0, end: 4 } }, { text: '第二句。', sourceTextRange: { start: 4, end: 8 } }], 0);
    expect(s.take(0, 0)).toEqual({ text: '第一句。 第二句。', sourceTextRange: { start: 0, end: 8 } });
    s.append([{ text: '第三句。', sourceTextRange: { start: 8, end: 12 } }], 0);
    expect(s.take(5000, 2000)).toBeUndefined();
    expect(s.take(5001, 100)?.text).toBe('第三句。');
  });
  it('holds a short acknowledgement briefly, but final and the first deadline never strand it', () => {
    const s = new VoiceChunkScheduler();
    s.append([{ text: '好的。', sourceTextRange: { start: 0, end: 3 } }], 0);
    expect(s.take(0, 0)).toBeUndefined();
    expect(s.take(399, 0)).toBeUndefined();
    expect(s.take(400, 0)?.text).toBe('好的。');
    const final = new VoiceChunkScheduler();
    final.append([{ text: '好的。', sourceTextRange: { start: 0, end: 3 } }], 0);
    expect(final.take(0, 0, true)?.text).toBe('好的。');
  });
  it('counts projection time toward the first phrase deadline without forcing unsafe fragments', () => {
    const s = new VoiceChunkScheduler(), projector = new VoiceTextProjector();
    s.start(0);
    s.append(projector.append('我先看看现在的实现，然后确认日期'), 0);
    expect(s.take(399, 0)).toBeUndefined();
    s.append(projector.flushWeakBoundary(), 400);
    expect(s.take(400, 0)?.text).toBe('我先看看现在的实现，');
    expect(s.take(800, 0)).toBeUndefined();
  });
  it('bounds coalesced text and keeps progress narration separate from the reply', () => {
    const s = new VoiceChunkScheduler({ maxChars: 10 });
    s.append([{ text: '我看一下。', sourceTextRange: { start: 0, end: 0 } },
      { text: '第一句话。', sourceTextRange: { start: 0, end: 5 } },
      { text: '第二句话。', sourceTextRange: { start: 5, end: 10 } }], 0);
    expect(s.take(0, 0, true)?.text).toBe('我看一下。');
    expect(s.take(0, 0, true)?.text).toBe('第一句话。');
    expect(s.take(0, 0, true)?.text).toBe('第二句话。');
    expect(s.queued).toBe(0);
  });
});

describe('delivery heard semantics', () => {
  const input = { voiceSessionId: 'session', turnId: 'turn', runId: 'run', generation: 1 };
  it('records only fully acknowledged segments as heard and rejects stale ACKs', () => {
    const ledger = new VoiceDeliveryLedger();
    for (const [id, spokenText] of [['one', '已听完。'], ['two', '未听完。']] as const) {
      ledger.queue({ ...input, id, spokenText });
      for (const state of ['synthesizing', 'ready', 'playing'] as const) expect(ledger.transition(id, 1, state)).toBe(true);
    }
    ledger.transition('one', 1, 'played', 100);
    ledger.transition('two', 1, 'partially_played', 20);
    expect(ledger.transition('two', 0, 'played')).toBe(false);
    ledger.interrupt('run', 1);
    expect(ledger.heardPrefix('run')).toBe('已听完。');
    expect(interruptedVoiceContext(ledger, 'run')).not.toContain('未听完。');
    expect(ledger.transition('two', 1, 'played')).toBe(false);
  });
  it('recovers crash state without treating ready or partially played audio as heard', () => {
    const ledger = new VoiceDeliveryLedger({ load: () => [{ ...input, id: 'one', spokenText: '尚未确认。', state: 'playing', playedMs: 3 }], save: () => undefined });
    expect(ledger.snapshot()[0]?.state).toBe('interrupted');
    expect(ledger.heardPrefix('run')).toBe('');
  });
});

it('narrates only real tool starts, coalescing repeated events', () => {
  const narrator = new CodingProgressNarrator();
  expect(narrator.onEvent({ type: 'text.delta', text: '我在测试' }, 0)).toBeUndefined();
  expect(narrator.onEvent({ type: 'tool.started', id: 'one', name: 'read_file', input: {} }, 0)).toBe('我看一下相关文件。');
  expect(narrator.onEvent({ type: 'tool.started', id: 'two', name: 'read_file', input: {} }, 9000)).toBeUndefined();
  expect(narrator.onEvent({ type: 'tool.started', id: 'three', name: 'terminal', input: {} }, 10000)).toBe('我运行一下命令，看看结果。');
});
