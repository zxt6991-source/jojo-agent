import { PlaybackEngine } from './playback-engine';
import type { PlaybackCommand, PlaybackEvent } from './types';

declare const sampleRate: number;
declare class AudioWorkletProcessor { readonly port: MessagePort; constructor(options?: unknown) }
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

class PlaybackProcessor extends AudioWorkletProcessor {
  private readonly engine: PlaybackEngine;
  private cursorFrames = 0;
  private renderFrame = 0;
  private referenceEnabled = false;
  private reference = new Float32Array(Math.ceil(sampleRate / 50));
  private referenceSize = 0;
  private stopped = false;

  constructor(options?: { processorOptions?: { capacityMs?: number } }) {
    super(options);
    this.engine = new PlaybackEngine(sampleRate, options?.processorOptions?.capacityMs);
    this.port.onmessage = (event: MessageEvent<PlaybackCommand>) => {
      const command = event.data;
      try {
        if (command.type === 'enqueue') {
          this.engine.enqueue(command.chunk);
          this.send({ type: 'enqueued', requestId: command.requestId, cursor: this.engine.cursor() });
        } else if (command.type === 'generation') { this.engine.setGeneration(command.generation); this.referenceSize = 0; }
        else if (command.type === 'duck') this.engine.duck(command.gain);
        else if (command.type === 'pause') this.engine.pause();
        else if (command.type === 'resume') this.engine.resume();
        else if (command.type === 'volume') this.engine.setVolume(command.gain);
        else if (command.type === 'flush') { this.engine.flush(command.options); this.referenceSize = 0; }
        else if (command.type === 'reference') { this.referenceEnabled = command.enabled; this.referenceSize = 0; }
        else if (command.type === 'stop') { this.engine.stop(); this.stopped = true; }
        this.send({ type: 'cursor', cursor: this.engine.cursor() });
      } catch (cause) {
        if (command.type === 'enqueue') this.send({ type: 'rejected', requestId: command.requestId, reason: cause instanceof Error ? cause.message : 'playback_error' });
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0]?.[0];
    if (!output) return !this.stopped;
    this.engine.render(output);
    for (const channel of outputs[0]!.slice(1)) channel.set(output);
    if (this.referenceEnabled) this.tap(output);
    this.renderFrame += output.length; this.cursorFrames += output.length;
    for (const segmentId of this.engine.drainCompletedSegments()) this.send({ type: 'segment-played', segmentId, generation: this.engine.cursor().generation, cursor: this.engine.cursor() });
    if (this.cursorFrames >= sampleRate / 50) { this.cursorFrames = 0; this.send({ type: 'cursor', cursor: this.engine.cursor() }); }
    return !this.stopped;
  }

  private tap(output: Float32Array): void {
    for (let index = 0; index < output.length; index += 1) {
      this.reference[this.referenceSize++] = output[index]!;
      if (this.referenceSize === this.reference.length) {
        const samples = this.reference;
        this.send({ type: 'reference', reference: { generation: this.engine.cursor().generation, sampleRate,
          renderFrame: this.renderFrame + index + 1 - samples.length, samples } }, [samples.buffer]);
        this.reference = new Float32Array(samples.length); this.referenceSize = 0;
      }
    }
  }
  private send(event: PlaybackEvent, transfer: Transferable[] = []): void { this.port.postMessage(event, transfer); }
}

registerProcessor('jojo-realtime-playback', PlaybackProcessor);
