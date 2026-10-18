import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createBufferedRealtimeTtsProvider, VoiceDeliveryLedger, withHeardVoiceContext } from '@desktop-agent/speech';
import { VoiceOutputFrameSchema, type Message, type ModelRequest, type SpeechEvent, type SpeechTtsProvider } from '@desktop-agent/contracts';
import { DesktopVoiceOutput } from './voice-output';
import { createSilentWavFixture } from '../testing/speech-audio-fixture';

const handle = { sessionId: 'session', runId: 'run', generation: 3 };
class Port extends EventEmitter {
  frames: unknown[] = [];
  autoAck = true;
  postMessage(value: unknown): void {
    this.frames.push(value);
    const frame = VoiceOutputFrameSchema.parse(value);
    if (frame.type !== 'pcm' || !this.autoAck) return;
    queueMicrotask(() => {
      this.emit('message', { data: { type: 'consumed', generation: frame.generation, sequence: frame.sequence, bufferedMs: 0 } });
      if (frame.sequence === 1) this.emit('message', { data: { type: 'started', generation: frame.generation, segmentId: frame.segmentId } });
      if (frame.final) this.emit('message', { data: { type: 'played', generation: frame.generation, segmentId: frame.segmentId } });
    });
  }
  close(): void { this.emit('close'); }
}
function setup() {
  const ledger = new VoiceDeliveryLedger(), events: SpeechEvent[] = [];
  const synthesize = vi.fn<SpeechTtsProvider['synthesize']>(async function* (input) {
    yield { type: 'audio', requestId: input.requestId, format: 'wav', sampleRate: 24000, bytes: createSilentWavFixture() };
    yield { type: 'completed', requestId: input.requestId };
  });
  const manager = new DesktopVoiceOutput({ ledger, emit: event => events.push(event), open: h => createBufferedRealtimeTtsProvider({ synthesize }).open({ ...h, speakerId: 'default', speechRate: 0 }) });
  return { manager, ledger, events, synthesize };
}
describe('Desktop streaming voice output', () => {
  it('starts synthesis from public deltas before Run final and reconciles without rereading', async () => {
    const { manager, ledger, events, synthesize } = setup();
    const port = new Port(); manager.begin(handle); manager.attach(handle, port);
    manager.event(handle.runId, { type: 'text.delta', text: '修好了。\n```ts\nsecret()\n```\n验证通过。' });
    await vi.waitFor(() => expect(synthesize).toHaveBeenCalled());
    expect(events.some(event => event.type === 'output_closed')).toBe(false);
    manager.finish('run', 'message-final', true);
    await vi.waitFor(() => expect(events).toContainEqual({ type: 'output_closed', ...handle, outcome: 'played' }));
    expect(ledger.heardPrefix('run')).toBe('修好了。 验证通过。');
    expect(ledger.snapshot().every(segment => segment.messageId === 'message-final')).toBe(true);
    expect(JSON.stringify(port.frames)).not.toContain('secret');
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(synthesize).toHaveBeenCalledWith(expect.objectContaining({ text: '修好了。 验证通过。' }));
  });
  it('stopping speech preserves the Run and an unacknowledged segment stays unheard', async () => {
    const { manager, ledger, events } = setup();
    const runController = new AbortController(), port = new Port(); port.autoAck = false;
    manager.begin(handle); manager.attach(handle, port); manager.event('run', { type: 'text.delta', text: '正在处理。' });
    await vi.waitFor(() => expect(port.frames.length).toBeGreaterThan(0));
    manager.stop('session'); manager.finish('run', 'display-final', true);
    expect(runController.signal.aborted).toBe(false);
    expect(ledger.heardPrefix('run')).toBe('');
    expect(events).toContainEqual({ type: 'output_closed', ...handle, outcome: 'interrupted' });
  });
  it('rejects unknown/stale output capabilities before opening TTS', () => {
    const { manager, synthesize } = setup();
    const port = new Port(); manager.begin(handle); manager.attach({ ...handle, generation: 2 }, port);
    expect(synthesize).not.toHaveBeenCalled(); manager.stop();
  });
  it('records an unheard boundary when stopped before any phrase or between phrases', () => {
    const { manager, ledger } = setup(); manager.begin(handle); manager.stop(); manager.finish('run', 'display-after-stop', true);
    expect(ledger.heardPrefix('run')).toBe('');
    expect(ledger.snapshot()).toContainEqual(expect.objectContaining({ messageId: 'display-after-stop', state: 'cancelled', spokenText: '' }));
  });
  it('changes only the next model request to a conservative heard prefix', async () => {
    const { manager, ledger } = setup(), port = new Port(); port.autoAck = false;
    manager.begin(handle); manager.attach(handle, port); manager.event('run', { type: 'text.delta', text: '屏幕上的完整答案。' });
    await vi.waitFor(() => expect(port.frames.length).toBeGreaterThan(0)); manager.stop(); manager.finish('run', 'message', true);
    let observed: ModelRequest | undefined;
    const provider = withHeardVoiceContext({ async *stream(request) { observed = request; yield { type: 'response_completed', stopReason: 'stop' }; } }, ledger);
    const message: Message = { id: 'message', role: 'assistant', createdAt: new Date().toISOString(), content: [{ type: 'text', text: '屏幕上的完整答案。' }] };
    for await (const event of provider.stream({ model: 'test', messages: [message], tools: [], signal: new AbortController().signal })) void event;
    expect(observed?.messages[0]?.content).toEqual([{ type: 'text', text: '\n[assistant was interrupted here]' }]);
    expect(message.content).toEqual([{ type: 'text', text: '屏幕上的完整答案。' }]);
  });
});
