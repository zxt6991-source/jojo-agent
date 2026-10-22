import type { DesktopApi, ReadSpeechMessageInput, SpeechPlaybackResult, SpeechPlaybackState } from '@desktop-agent/contracts';
type SpeechApi = Pick<DesktopApi, 'readSpeechMessage' | 'onSpeechEvent' | 'getSpeechStatus' | 'stopSpeechPlayback'>;
const cancelled = () => new DOMException('Speech reading cancelled', 'AbortError');

/** Start with the first segment and let Main prefetch the remaining message.
 * Only the real ended receipt confirms that the entire reading was heard. */
export async function readRequestedSpeech(api: SpeechApi, input: ReadSpeechMessageInput, options: { signal: AbortSignal; isAllowed(): boolean }): Promise<void> {
  if (options.signal.aborted || !options.isAllowed()) return;
  await playSegment(api, { ...input, automatic: false, complete: true, offset: input.offset ?? 0 }, options.signal);
}

function playSegment(api: SpeechApi, input: ReadSpeechMessageInput, signal: AbortSignal): Promise<SpeechPlaybackResult | undefined> {
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    let result: SpeechPlaybackResult | undefined;
    let settled = false;
    const states = new Map<string, SpeechPlaybackState>();
    const cleanup = () => { clearTimeout(timer); unsubscribe(); signal.removeEventListener('abort', abort); };
    const finish = (value?: SpeechPlaybackResult, error?: Error) => {
      if (settled) return; settled = true; cleanup(); if (error) reject(error); else resolve(value);
    };
    const abort = () => {
      void api.stopSpeechPlayback(result ? { playbackId: result.playbackId } : { sessionId: input.sessionId, generation: input.generation }).catch(() => undefined);
      finish(undefined, cancelled());
    };
    const inspect = (state: SpeechPlaybackState | undefined) => {
      if (!state || !result || state.playbackId !== result.playbackId || state.generation !== input.generation) return;
      if (state.state === 'played') finish(result);
      else if (state.state === 'interrupted' || state.state === 'suppressed') finish();
      else if (state.state === 'failed') finish(undefined, new Error(state.reason ?? '朗读未完成，请重试。'));
    };
    const timer = setTimeout(() => { abort(); }, input.complete ? 3_600_000 : 305_000);
    const unsubscribe = api.onSpeechEvent(event => {
      if (event.type !== 'playback' || event.sessionId !== input.sessionId || event.messageId !== input.messageId || event.generation !== input.generation) return;
      states.set(event.playbackId, event); if (states.size > 100) states.delete(states.keys().next().value!);
      inspect(event);
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    void api.readSpeechMessage(input).then(async value => {
      result = value;
      if (settled) { if (signal.aborted) void api.stopSpeechPlayback({ playbackId: value.playbackId }).catch(() => undefined); return; }
      inspect(states.get(value.playbackId));
      if (!settled) {
        try { const status = await api.getSpeechStatus(); inspect(status.playbacks.find(state => state.playbackId === value.playbackId)); }
        catch { /* Events remain authoritative; the deadline bounds a lost channel. */ }
      }
    }, error => finish(undefined, error instanceof Error ? error : new Error('朗读未完成，请重试。')));
  });
}
