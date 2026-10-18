import { describe, expect, it, vi } from 'vitest';
import type { DesktopApi, SpeechEvent } from '@desktop-agent/contracts';
import { readRequestedSpeech } from './requested-speech';

const input = { sessionId: 'session', messageId: 'message', generation: 7 };
function setup() {
  const listeners = new Set<(event: SpeechEvent) => void>();
  const emit = (event: SpeechEvent) => listeners.forEach(listener => listener(event));
  const api: Pick<DesktopApi, 'readSpeechMessage' | 'getSpeechStatus' | 'onSpeechEvent' | 'stopSpeechPlayback'> = {
    readSpeechMessage: vi.fn(async value => ({ playbackId: `playback-${value.offset ?? 0}`, generation: value.generation })),
    onSpeechEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSpeechStatus: vi.fn(async () => ({ captures: [], playbacks: [], validation: { asr: true, tts: true } })),
    stopSpeechPlayback: vi.fn(async () => undefined)
  };
  const playback = (offset: number, state: 'playing' | 'played' | 'interrupted' | 'failed') => emit({ type: 'playback', ...input, playbackId: `playback-${offset}`, state });
  return { api, emit, playback, listeners };
}
describe('one-turn requested reading', () => {
  it('requests a complete prepared reading once and confirms completion only at actual ended', async () => {
    const h = setup(), controller = new AbortController();
    let finished = false;
    const reading = readRequestedSpeech(h.api, input, { signal: controller.signal, isAllowed: () => true }).then(() => { finished = true; });
    await vi.waitFor(() => expect(h.api.readSpeechMessage).toHaveBeenCalledTimes(1));
    expect(h.api.readSpeechMessage).toHaveBeenCalledWith({ ...input, offset: 0, automatic: false, complete: true });
    h.playback(0, 'playing'); await Promise.resolve(); expect(finished).toBe(false);
    h.playback(0, 'played'); await reading;
    expect(h.api.readSpeechMessage).toHaveBeenCalledOnce(); expect(h.listeners.size).toBe(0);
  });
  it('stops the chain on interruption and never skips to the next unheard segment', async () => {
    const h = setup();
    const reading = readRequestedSpeech(h.api, input, { signal: new AbortController().signal, isAllowed: () => true });
    await vi.waitFor(() => expect(h.api.readSpeechMessage).toHaveBeenCalledOnce());
    h.playback(0, 'interrupted'); await reading; expect(h.api.readSpeechMessage).toHaveBeenCalledOnce();
  });
  it('cancels pending playback on a session change or microphone start', async () => {
    const h = setup(), controller = new AbortController();
    const reading = readRequestedSpeech(h.api, input, { signal: controller.signal, isAllowed: () => true });
    const assertion = expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(h.api.readSpeechMessage).toHaveBeenCalledOnce()); controller.abort(); await assertion;
    expect(h.api.stopSpeechPlayback).toHaveBeenCalled(); expect(h.listeners.size).toBe(0);
  });
  it('retains a played ACK that arrives before the IPC result', async () => {
    const h = setup();
    vi.mocked(h.api.readSpeechMessage).mockImplementation(async value => { h.playback(0, 'played'); return { playbackId: 'playback-0', generation: value.generation }; });
    await readRequestedSpeech(h.api, input, { signal: new AbortController().signal, isAllowed: () => true });
    expect(h.api.readSpeechMessage).toHaveBeenCalledOnce(); expect(h.listeners.size).toBe(0);
  });
  it('prepares all remaining text from a supplied manual continuation offset', async () => {
    const h = setup();
    const reading = readRequestedSpeech(h.api, { ...input, offset: 200 }, { signal: new AbortController().signal, isAllowed: () => true });
    await vi.waitFor(() => expect(h.api.readSpeechMessage).toHaveBeenCalledOnce());
    expect(h.api.readSpeechMessage).toHaveBeenCalledWith({ ...input, offset: 200, automatic: false, complete: true });
    h.playback(200, 'played'); await reading; expect(h.listeners.size).toBe(0);
  });
  it('does not start when playback permission has already been revoked', async () => {
    const h = setup();
    await readRequestedSpeech(h.api, input, { signal: new AbortController().signal, isAllowed: () => false });
    expect(h.api.readSpeechMessage).not.toHaveBeenCalled(); expect(h.listeners.size).toBe(0);
  });
});
