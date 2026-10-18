import { useEffect, useRef } from 'react';
import { VoiceOutputFrameSchema, VoiceOutputHandleSchema, type DesktopApi, type VoiceOutputHandle } from '@desktop-agent/contracts';
import { sharedRealtimeVoiceGraph, subscribeVoiceGraph, closeSharedVoiceGraph } from './shared-graph';

interface Options { api: DesktopApi; sessionId?: string; enabled: boolean; allowPlayback: boolean; volume: number; onError(message: string): void }
/** PCM stays on a dedicated port and a bounded worklet ring. */
export function useRealtimeVoiceOutput(options: Options): void {
  const current = useRef(options); current.current = options;
  useEffect(() => {
    if (!options.enabled || !options.allowPlayback || !options.sessionId || options.volume <= 0) return;
    let live = true;
    let handle: VoiceOutputHandle | undefined;
    let port: MessagePort | undefined;
    let expectedSequence = 1;
    let started = false;
    let attaching: ReturnType<typeof setTimeout> | undefined;
    let receiveChain: Promise<void> = Promise.resolve();
    const same = (value: VoiceOutputHandle) => handle && value.runId === handle.runId && value.sessionId === handle.sessionId && value.generation === handle.generation;
    const end = (notify = true) => {
      clearTimeout(attaching);
      if (port && handle && notify) port.postMessage({ type: 'cancel', generation: handle.generation });
      port?.close(); port = undefined;
      if (handle) sharedRealtimeVoiceGraph().flush({ generation: handle.generation });
      handle = undefined;
    };
    const fail = () => { end(); if (live) current.current.onError('实时朗读已停止，完整结果仍可在屏幕查看。'); };
    const unsubscribeGraph = subscribeVoiceGraph({
      onCursor: cursor => {
        if (!port || !handle || cursor.generation !== handle.generation || started || cursor.playedFrames === 0 || !cursor.segmentId) return;
        started = true; port.postMessage({ type: 'started', generation: handle.generation, segmentId: cursor.segmentId });
      },
      onSegmentPlayed: (segmentId, generation) => { if (port && handle?.generation === generation) port.postMessage({ type: 'played', generation, segmentId }); },
      onError: fail
    });
    const receivePort = (event: MessageEvent) => {
      if (event.source !== window || event.data?.type !== 'jojo.voice.output.port') return;
      const binding = VoiceOutputHandleSchema.safeParse(event.data.handle);
      if (!binding.success || !same(binding.data) || event.ports.length !== 1) { event.ports.forEach(item => item.close()); return; }
      clearTimeout(attaching);
      port = event.ports[0]!;
      const connection = port;
      port.onmessage = message => {
        receiveChain = receiveChain.then(async () => {
          if (!live || port !== connection || !handle) return;
          const parsed = VoiceOutputFrameSchema.safeParse(message.data);
          if (!parsed.success || !same(parsed.data)) throw new Error('invalid_voice_output_frame');
          const frame = parsed.data;
          if (frame.type === 'cancelled' || frame.type === 'failed') { end(false); return; }
          if (frame.type === 'finished') return; // The final worklet ACK establishes hearing.
          if (frame.sequence !== expectedSequence++) throw new Error('voice_output_sequence_gap');
          const graph = sharedRealtimeVoiceGraph();
          await graph.enqueuePcm({ segmentId: frame.segmentId, generation: frame.generation, sequence: frame.sequence,
            bytes: frame.pcm, sampleRate: frame.sampleRate, channels: 1, format: 'pcm16le', endOfSegment: frame.final });
          while (live && port === connection && graph.bufferedMs >= 1500) await new Promise(resolve => setTimeout(resolve, 20));
          if (live && port === connection) connection.postMessage({ type: 'consumed', generation: frame.generation, sequence: frame.sequence, bufferedMs: graph.bufferedMs });
        }).catch(fail);
      };
      port.onmessageerror = fail;
      port.start();
    };
    window.addEventListener('message', receivePort);
    const unsubscribe = options.api.onSpeechEvent(event => {
      if (event.type === 'output_closed' && same(event)) { end(false); return; }
      if (event.type !== 'output_available' || event.sessionId !== current.current.sessionId || !current.current.enabled || !current.current.allowPlayback) return;
      end();
      handle = { sessionId: event.sessionId, runId: event.runId, generation: event.generation };
      expectedSequence = 1; started = false;
      const graph = sharedRealtimeVoiceGraph();
      void graph.start().then(() => {
        if (!live || !handle || !same(event)) return;
        graph.setGeneration(event.generation); graph.setVolume(current.current.volume);
        attaching = setTimeout(fail, 10_000);
        return options.api.attachVoiceOutput(handle);
      }).catch(fail);
    });
    const deviceChange = () => { if (handle) { fail(); void options.api.stopSpeechPlayback({ sessionId: options.sessionId! }); } };
    navigator.mediaDevices?.addEventListener('devicechange', deviceChange);
    const unload = () => { end(); void closeSharedVoiceGraph(); };
    window.addEventListener('pagehide', unload);
    return () => {
      live = false; end(); unsubscribe(); unsubscribeGraph();
      window.removeEventListener('message', receivePort); window.removeEventListener('pagehide', unload);
      navigator.mediaDevices?.removeEventListener('devicechange', deviceChange);
    };
  }, [options.api, options.sessionId, options.enabled, options.allowPlayback, options.volume]);
}
