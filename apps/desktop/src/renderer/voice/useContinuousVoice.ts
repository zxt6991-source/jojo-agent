import { useEffect, useRef, useState } from 'react';
import type { DesktopApi, SpeechCaptureHandle, SpeechCaptureState } from '@desktop-agent/contracts';
import type { CaptureFailure } from '../audio/capture-failure';
import { ContinuousVoiceSession, type ContinuousVoiceState } from './continuous-session';

interface Options {
  api: DesktopApi; sessionId?: string; enabled: boolean; inputDeviceId?: string;
  startCapture(): Promise<void>; cancelCapture(): void; canStart(): boolean;
  autoRead: boolean; onNotice(message: string): void;
  onCaptureDiscarded?(): void;
}
export function useContinuousVoice(options: Options) {
  const current = useRef(options); current.current = options;
  const scope = useRef(options.sessionId);
  const [state, setState] = useState<ContinuousVoiceState>('off');
  const session = useRef<ContinuousVoiceSession | undefined>(undefined);
  session.current ??= new ContinuousVoiceSession({
    startCapture: () => current.current.startCapture(), cancelCapture: () => { current.current.cancelCapture(); current.current.onCaptureDiscarded?.(); },
    canStart: () => current.current.enabled && current.current.canStart(), autoRead: () => current.current.autoRead,
    stopPlayback: () => { void current.current.api.stopSpeechPlayback(scope.current ? { sessionId: scope.current } : {}).catch(() => undefined); },
    onState: setState, onNotice: message => current.current.onNotice(message)
  });
  useEffect(() => {
    const controller = session.current!;
    const offSpeech = options.api.onSpeechEvent(event => {
      if (event.type === 'input_invalidated' || ('sessionId' in event && event.sessionId === current.current.sessionId)) controller.speech(event);
    });
    const stop = () => controller.stop();
    const key = (event: KeyboardEvent) => {
      if (controller.state() === 'off') return;
      if (event.key === 'Escape') { event.preventDefault(); stop(); }
      else if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.code === 'KeyM') {
        event.preventDefault(); if (controller.state() === 'muted') controller.resume(); else controller.mute();
      }
    };
    navigator.mediaDevices?.addEventListener('devicechange', stop);
    window.addEventListener('pagehide', stop); window.addEventListener('keydown', key);
    return () => { offSpeech(); stop(); navigator.mediaDevices?.removeEventListener('devicechange', stop); window.removeEventListener('pagehide', stop); window.removeEventListener('keydown', key); };
  }, [options.api]);
  useEffect(() => { session.current?.stop(); scope.current = options.sessionId; }, [options.sessionId, options.inputDeviceId]);
  useEffect(() => { if (!options.enabled) session.current?.stop(); }, [options.enabled]);
  return { state, start: () => session.current!.start(), stop: () => session.current!.stop(), mute: () => session.current!.mute(), resume: () => session.current!.resume(),
    captureStarted: (capture: SpeechCaptureHandle) => session.current!.captureStarted(capture),
    captureFailed: (failure: CaptureFailure) => session.current!.captureFailed(failure),
    finalReceived: (capture: Pick<SpeechCaptureState, 'voiceTurnId' | 'generation'>) => session.current!.finalReceived(capture) };
}
