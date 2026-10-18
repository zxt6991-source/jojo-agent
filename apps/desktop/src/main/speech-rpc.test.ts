import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerCommand } from '@desktop-agent/contracts';
import { SpeechRpcClient } from './speech-rpc';

afterEach(() => vi.useRealTimers());
describe('speech process request deadlines', () => {
  it('allows neural preparation past the ordinary IPC deadline while status retains its short deadline', async () => {
    vi.useFakeTimers();
    const sent: WorkerCommand[] = [], client = new SpeechRpcClient(command => sent.push(command));
    const reading = client.request({ action: 'readMessage', input: { sessionId: 's', messageId: 'm', generation: 1, complete: true } });
    let done = false; void reading.then(() => { done = true; });
    const status = client.request({ action: 'status' }); const assertion = expect(status).rejects.toThrow('超时');
    await vi.advanceTimersByTimeAsync(45_001); await assertion; expect(done).toBe(false);
    const command = sent[0]!; if (command.type !== 'speech.control') throw new Error('wrong command');
    client.accept({ type: 'speech.result', requestId: command.requestId, ok: true });
    await expect(reading).resolves.toBeUndefined(); client.close();
  });
  it('still bounds full preparation and rejects pending requests on process shutdown', async () => {
    vi.useFakeTimers(); const client = new SpeechRpcClient(() => undefined);
    const reading = client.request({ action: 'readMessage', input: { sessionId: 's', messageId: 'm', generation: 1, complete: true } });
    const timedOut = expect(reading).rejects.toThrow('超时'); await vi.advanceTimersByTimeAsync(550_000); await timedOut;
    const preview = client.request({ action: 'test', input: { generation: 2 } });
    const closed = expect(preview).rejects.toThrow('已结束'); client.close(); await closed;
  });
});
