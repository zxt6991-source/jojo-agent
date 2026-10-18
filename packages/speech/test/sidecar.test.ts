import { describe, expect, it } from 'vitest';
import { encodeSidecarFrame, SidecarFrameDecoder, SpeechSidecarClient, type SpeechSidecarTransport, type SidecarEvent } from '../src/sidecar';
const context = { voiceSessionId: 'voice', captureId: 'capture', turnId: 'turn', generation: 1 };
class Transport implements SpeechSidecarTransport {
  receive: (bytes: Uint8Array) => void = () => undefined;
  disconnected: (error?: Error) => void = () => undefined;
  controls: Record<string, unknown>[] = [];
  send(event: SidecarEvent): void { this.receive(encodeSidecarFrame(event)); }
  subscribe(listener: (bytes: Uint8Array) => void, onClose: (error?: Error) => void): () => void {
    this.receive = listener; this.disconnected = onClose;
    queueMicrotask(() => this.send({ type: 'ready', protocolVersion: 1, capabilities: { vad: { available: true }, streamingAsr: { available: true }, smartTurn: { available: false } } }));
    return () => { this.receive = () => undefined; };
  }
  async write(bytes: Uint8Array): Promise<void> {
    const frame = new SidecarFrameDecoder().push(bytes)[0]!; this.controls.push(frame.header);
    const command = frame.header;
    if (command.type === 'audio.frame') this.send({ type: 'audio.ack', ...context, generation: command.generation as number, sequence: command.sequence as number });
    if (command.type === 'session.open') this.send({ type: 'session.opened', ...context });
    if (command.type === 'session.close') this.send({ type: 'session.closed', ...context });
  }
  async close(): Promise<void> { this.receive = () => undefined; }
}
describe('binary speech sidecar', () => {
  it('decodes every split point without changing PCM or allocating declared oversized frames', () => {
    const bytes = encodeSidecarFrame({ type: 'audio.frame', ...context }, new Uint8Array([0, 1, 2, 3]));
    for (let split = 1; split < bytes.length; split++) {
      const d = new SidecarFrameDecoder(); expect([...d.push(bytes.subarray(0, split)), ...d.push(bytes.subarray(split))]).toEqual([{ header: { type: 'audio.frame', ...context }, body: new Uint8Array([0, 1, 2, 3]) }]); d.finish();
    }
    expect(() => new SidecarFrameDecoder().push(new Uint8Array([127, 255, 255, 255]))).toThrow();
    const d = new SidecarFrameDecoder(); d.push(bytes.subarray(0, 8)); expect(() => d.finish()).toThrow('Truncated');
  });
  it('keeps the process warm across frames, ignores stale events, and closes explicitly', async () => {
    const transport = new Transport(); let connections = 0;
    const client = new SpeechSidecarClient({ connect: async () => { connections++; return transport; } });
    const events: SidecarEvent[] = []; client.subscribe(event => events.push(event));
    await client.open(context); await client.sendAudio(context, 0, new Uint8Array([1, 2])); await client.sendAudio(context, 2, new Uint8Array([3, 4]));
    transport.send({ type: 'asr.final', ...context, generation: 0, text: 'stale' });
    transport.send({ type: 'asr.partial', ...context, text: '当前' });
    expect(connections).toBe(1); expect(events.some(event => event.type === 'asr.final')).toBe(false); expect(events.some(event => event.type === 'asr.partial')).toBe(true);
    await expect(client.sendAudio(context, 1, new Uint8Array([1, 2]))).rejects.toThrow('sequence');
    await client.close(context); await client.dispose();
  });
  it('notifies capture adapters of idle process loss without waiting for another audio frame', async () => {
    const transport = new Transport(), failures: Error[] = [];
    const client = new SpeechSidecarClient({ connect: async () => transport });
    const unsubscribe = client.onFailure(error => failures.push(error));
    await client.open(context);
    transport.disconnected();
    expect(failures.map(error => error.message)).toEqual(['Speech sidecar disconnected.']);
    await expect(client.sendAudio(context, 0, new Uint8Array([1, 2]))).rejects.toThrow('Stale');
    unsubscribe(); await client.dispose();
    expect(failures).toHaveLength(1);
  });
});
