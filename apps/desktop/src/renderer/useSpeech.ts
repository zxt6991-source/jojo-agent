import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopApi, SpeechCaptureHandle, SpeechCaptureState, SpeechPlaybackState, SpeechStatus } from '@desktop-agent/contracts';
import { PcmRecorder } from './audio/pcm-recorder';
import { SpeechReplyGate } from './speech-reply';

let generationCounter = 0;
export const nextSpeechGeneration = () => ++generationCounter;
export type CaptureView = { state: 'idle' | SpeechCaptureState['state']; durationMs: number; rms: number; error: string };
const idle: CaptureView = { state: 'idle', durationMs: 0, rms: 0, error: '' };
const cancelled = () => new DOMException('Cancelled', 'AbortError');
const sameCapture = (left: SpeechCaptureHandle, right: SpeechCaptureHandle) => left.captureId === right.captureId && left.generation === right.generation;

function capturePort(api: DesktopApi, handle: SpeechCaptureHandle, signal: AbortSignal): Promise<MessagePort> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { window.removeEventListener('message', receive); signal.removeEventListener('abort', abort); clearTimeout(timer); };
    const abort = () => { cleanup(); reject(cancelled()); };
    const receive = (event: MessageEvent) => {
      if (event.source !== window || event.data?.type !== 'jojo.speech.capture.port') return;
      if (!event.data.handle || !sameCapture(handle, event.data.handle)) return;
      const port = event.ports[0];
      if (!port) return;
      cleanup(); resolve(port);
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error('语音通道未连接，请重试。')); }, 10_000);
    window.addEventListener('message', receive); signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    void api.attachSpeechCapture(handle).catch(cause => { cleanup(); reject(cause); });
  });
}

function providerReady(api: DesktopApi, handle: SpeechCaptureHandle, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let unsubscribe: () => void = () => undefined;
    const cleanup = () => { unsubscribe(); signal.removeEventListener('abort', abort); clearTimeout(timer); };
    const abort = () => { cleanup(); reject(cancelled()); };
    const receive = (state: SpeechCaptureState) => {
      if (!sameCapture(handle, state)) return;
      if (state.state === 'ready' || state.state === 'recording') { cleanup(); resolve(); }
      else if (state.state === 'failed' || state.state === 'cancelled') { cleanup(); reject(new Error(state.reason ?? '语音连接失败。')); }
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error('语音服务初始化超时，请检查本地模型或云端连接。')); }, 35_000);
    unsubscribe = api.onSpeechEvent(event => { if (event.type === 'capture') receive(event); });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    void api.getSpeechStatus().then(status => status.captures.forEach(receive)).catch(cause => { cleanup(); reject(cause); });
  });
}

export function useSpeechCapture({ api, sessionId, purpose, inputDeviceId, onFinal }: {
  api: DesktopApi; sessionId?: string; purpose: 'conversation' | 'validation'; inputDeviceId?: string;
  onFinal: (capture: SpeechCaptureState) => void;
}) {
  const [view, setView] = useState<CaptureView>(idle);
  const handle = useRef<SpeechCaptureHandle | undefined>(undefined);
  const recorder = useRef<PcmRecorder | undefined>(undefined);
  const controller = useRef<AbortController | undefined>(undefined);
  const activeGeneration = useRef(0);
  const final = useRef(onFinal); final.current = onFinal;
  const deliveredFinal = useRef<string | undefined>(undefined);

  const cancel = useCallback(() => {
    activeGeneration.current = nextSpeechGeneration();
    controller.current?.abort(); controller.current = undefined;
    recorder.current?.close(); recorder.current = undefined;
    const current = handle.current; handle.current = undefined;
    if (current) void api.cancelSpeechCapture(current).catch(() => undefined);
    setView(idle);
  }, [api]);

  useEffect(() => { cancel(); return cancel; }, [sessionId, purpose, cancel]);

  useEffect(() => api.onSpeechEvent(event => {
    const current = handle.current;
    if (event.type !== 'capture' || !current || !sameCapture(current, event) || current.generation !== activeGeneration.current) return;
    if (event.state === 'review') {
      recorder.current?.close(); recorder.current = undefined;
      setView(previous => ({ ...previous, state: 'review', rms: 0 }));
      if (deliveredFinal.current !== event.captureId && event.text?.trim()) { deliveredFinal.current = event.captureId; final.current(event); }
    } else if (event.state === 'failed' || event.state === 'cancelled') {
      recorder.current?.close(); recorder.current = undefined;
      controller.current?.abort(); controller.current = undefined; handle.current = undefined;
      activeGeneration.current = nextSpeechGeneration();
      setView(previous => ({ ...previous, state: 'idle', rms: 0, error: event.reason ?? (event.state === 'failed' ? '语音识别失败，请重录。' : '') }));
    } else if (event.state === 'recognizing') setView(previous => ({ ...previous, state: 'recognizing', rms: 0 }));
  }), [api]);

  const start = useCallback(async () => {
    cancel();
    const generation = nextSpeechGeneration(); activeGeneration.current = generation;
    const abort = new AbortController(); controller.current = abort;
    setView({ ...idle, state: 'connecting' });
    const fail = (message: string) => {
      if (activeGeneration.current !== generation || abort.signal.aborted) return;
      cancel(); setView({ ...idle, error: message });
    };
    try {
      await api.stopSpeechPlayback(sessionId ? { sessionId } : {});
      const current = await api.beginSpeechCapture({ ...(sessionId ? { sessionId } : {}), purpose, generation });
      if (abort.signal.aborted) { await api.cancelSpeechCapture(current); return; }
      handle.current = current;
      const port = await capturePort(api, current, abort.signal);
      try { await providerReady(api, current, abort.signal); } catch (cause) { port.close(); throw cause; }
      if (abort.signal.aborted) { port.close(); return; }
      const capture = new PcmRecorder(value => {
        if (activeGeneration.current === generation) setView(previous => ({ ...previous, ...value }));
      }, () => {
        if (activeGeneration.current === generation) setView(previous => ({ ...previous, state: 'recognizing', rms: 0 }));
      }, fail);
      recorder.current = capture;
      await capture.start(current, port, abort.signal, inputDeviceId);
      if (!abort.signal.aborted && activeGeneration.current === generation) setView(previous => ({ ...previous, state: 'recording' }));
    } catch (cause) {
      if (!abort.signal.aborted) fail(cause instanceof Error ? cause.message : '无法开始录音。');
    }
  }, [api, cancel, inputDeviceId, purpose, sessionId]);

  const stop = useCallback(() => {
    if (view.state === 'connecting') { cancel(); return; }
    if (view.state !== 'recording') return;
    setView(previous => ({ ...previous, state: 'recognizing', rms: 0 })); recorder.current?.stop();
  }, [view.state, cancel]);

  return { ...view, start, stop, cancel, handle: handle.current };
}

export function useSpeechStatus(api: DesktopApi) {
  const [status, setStatus] = useState<SpeechStatus>({ captures: [], playbacks: [], validation: { asr: false, tts: false } });
  useEffect(() => {
    let live = true;
    void api.getSpeechStatus().then(value => { if (live) setStatus(value); }).catch(() => undefined);
    const unsubscribe = api.onSpeechEvent(event => {
      if (event.type === 'validation') setStatus(previous => ({ ...previous, validation: { asr: event.asr, tts: event.tts } }));
      else if (event.type === 'playback') setStatus(previous => ({ ...previous, playbacks: [...previous.playbacks.filter(item => item.playbackId !== event.playbackId), event].slice(-100) }));
    });
    return () => { live = false; unsubscribe(); };
  }, [api]);
  return status;
}

export function activeSpeechPlayback(playbacks: SpeechPlaybackState[], sessionId?: string) {
  return [...playbacks].reverse().find(item => (!sessionId || item.sessionId === sessionId) && ['queued', 'preparing', 'playing'].includes(item.state));
}

/** Only the latest successfully played segment can offer continuation. A newer
 * preparation, stop or failure must not accidentally skip an unheard segment. */
export function getSpeechContinuation(playbacks: SpeechPlaybackState[], sessionId: string, messageId: string): number | undefined {
  const latest = [...playbacks].reverse().find(item => item.sessionId === sessionId && item.messageId === messageId);
  return latest?.state === 'played' ? latest.nextOffset : undefined;
}

export function useSpeechAutoRead(api: DesktopApi, context: { sessionId?: string; readSessionId?: () => string | null; isAutoReadAllowed?: () => boolean; enabled: boolean; autoReadReplies: boolean; allowPlayback: boolean }, onError: (message: string) => void) {
  const current = useRef(context); current.current = context;
  const error = useRef(onError); error.current = onError;
  const gate = useRef(new SpeechReplyGate());
  useEffect(() => api.onSpeechEvent(event => {
    if (event.type !== 'reply') return;
    const { sessionId, readSessionId, isAutoReadAllowed, ...preferences } = current.current;
    const active = readSessionId ? readSessionId() : sessionId;
    const input = gate.current.accept(event, { ...preferences, autoReadReplies: preferences.autoReadReplies && (isAutoReadAllowed?.() ?? true), ...(active ? { sessionId: active } : {}), generation: nextSpeechGeneration() });
    if (input) void api.readSpeechMessage(input).catch(cause => {
      const activeNow = current.current.readSessionId ? current.current.readSessionId() : current.current.sessionId;
      if (activeNow === input.sessionId && (current.current.isAutoReadAllowed?.() ?? true)) error.current(cause instanceof Error ? cause.message : String(cause));
    });
  }), [api]);
}
