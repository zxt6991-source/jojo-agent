import { VoiceAudioGraph, type VoiceAudioGraphOptions } from './voice-audio-graph';
const listeners = new Set<VoiceAudioGraphOptions>();
let graph: VoiceAudioGraph | undefined;
export function sharedRealtimeVoiceGraph(): VoiceAudioGraph {
  graph ??= new VoiceAudioGraph({
    onCaptureUpdate: value => listeners.forEach(listener => listener.onCaptureUpdate?.(value)),
    onCaptureStopped: () => listeners.forEach(listener => listener.onCaptureStopped?.()),
    onCursor: value => listeners.forEach(listener => listener.onCursor?.(value)),
    onSegmentPlayed: (id, generation) => listeners.forEach(listener => listener.onSegmentPlayed?.(id, generation)),
    onError: (message, code) => listeners.forEach(listener => listener.onError?.(message, code))
  });
  return graph;
}
export function subscribeVoiceGraph(listener: VoiceAudioGraphOptions): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export async function closeSharedVoiceGraph(): Promise<void> { const current = graph; graph = undefined; await current?.close(); }
