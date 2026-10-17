import { describe, expect, it, vi } from 'vitest';
import { AudioHostPlayer, type AudioElementPort } from './player';
import { isAudioHostAck, isAudioHostCommand, type AudioHostAck } from './ipc';
import { randomUUID } from 'node:crypto';
import { createSilentWavFixture } from '../testing/speech-audio-fixture';

class FakeAudio implements AudioElementPort {
  src = ''; volume = 1;
  listeners = new Map<string, Set<() => void>>();
  play = vi.fn(async () => undefined);
  pause = vi.fn(); removeAttribute = vi.fn(); load = vi.fn();
  addEventListener(name: string, listener: () => void) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name)!.add(listener); }
  removeEventListener(name: string, listener: () => void) { this.listeners.get(name)?.delete(listener); }
  emit(name: string) { this.listeners.get(name)?.forEach((listener) => listener()); }
}
function setup() {
  const audios: FakeAudio[] = [], acks: AudioHostAck[] = [];
  const revokeUrl = vi.fn();
  const player = new AudioHostPlayer({
    createAudio() { const audio = new FakeAudio(); audios.push(audio); return audio; },
    createUrl: () => `blob:private-${audios.length}`, revokeUrl, acknowledge: (ack) => acks.push(ack)
  });
  const command = () => ({ type: 'play' as const, token: randomUUID(), generation: 1, volume: 0.4, bytes: new Uint8Array([1, 2, 3]) });
  return { player, audios, acks, revokeUrl, command };
}
describe('the AudioHost player', () => {
  it('selects WAV explicitly and preserves MP3 as the legacy default', () => {
    const createUrl = vi.fn(() => 'blob:audio'); const player = new AudioHostPlayer({
      createAudio: () => new FakeAudio(), createUrl, revokeUrl: vi.fn(), acknowledge: vi.fn()
    });
    const wav = { type: 'play' as const, token: randomUUID(), generation: 1, volume: 0, bytes: createSilentWavFixture(), format: 'wav' as const };
    player.receive(wav); expect(createUrl).toHaveBeenLastCalledWith(wav.bytes, 'wav');
    const mp3 = { type: 'play' as const, token: randomUUID(), generation: 1, volume: 0, bytes: Uint8Array.of(1) };
    player.receive(mp3); expect(createUrl).toHaveBeenLastCalledWith(mp3.bytes, 'mp3'); player.dispose();
  });
  it('confirms started on playing and played only on ended, then frees the Blob', () => {
    const { player, audios, acks, revokeUrl, command } = setup();
    const input = command(); player.receive(input);
    expect(acks).toEqual([]); expect(audios[0]!.volume).toBe(0.4);
    audios[0]!.emit('playing'); audios[0]!.emit('ended');
    expect(acks).toEqual([{ type: 'started', token: input.token, generation: 1 }, { type: 'ended', token: input.token, generation: 1 }]);
    expect(revokeUrl).toHaveBeenCalledOnce();
    expect(audios[0]!.pause).toHaveBeenCalledOnce();
  });
  it('stops only the authorized token and rejects callbacks from an old player', async () => {
    const { player, audios, acks, command } = setup();
    const first = command(); player.receive(first);
    const lateEnded = [...audios[0]!.listeners.get('ended')!][0]!;
    const second = command(); player.receive(second);
    player.receive({ type: 'stop', token: first.token }); lateEnded();
    expect(audios[1]!.pause).not.toHaveBeenCalled(); expect(acks).toEqual([]);
    player.receive({ type: 'stop', token: second.token });
    expect(audios[1]!.pause).toHaveBeenCalledOnce();
    await Promise.resolve(); expect(acks).toEqual([]);
  });
  it('reports autoplay denial explicitly and retains no Blob', async () => {
    const { player, audios, acks, revokeUrl, command } = setup();
    const input = command(); player.receive(input);
    const error = new Error('denied'); error.name = 'NotAllowedError';
    // The initial promise has resolved; force a second play with a rejected promise.
    const next = new AudioHostPlayer({ createAudio: () => {
      const audio = audios[0]!; audio.play.mockRejectedValueOnce(error); return audio;
    }, createUrl: () => 'blob:denied', revokeUrl, acknowledge: (ack) => acks.push(ack) });
    player.dispose(); next.receive(input); await Promise.resolve();
    expect(acks).toEqual([{ type: 'error', token: input.token, generation: 1, reason: 'autoplay_denied' }]);
    expect(revokeUrl).toHaveBeenCalledWith('blob:denied');
  });
  it.each(['error', 'devicechange'])('terminates and cleans up on %s', (kind) => {
    const { player, audios, acks, revokeUrl, command } = setup();
    const input = command(); player.receive(input);
    if (kind === 'error') audios[0]!.emit('error'); else player.outputDeviceChanged();
    expect(acks.at(-1)).toEqual({ type: 'error', token: input.token, generation: 1, reason: kind === 'error' ? 'decode_failed' : 'output_device_changed' });
    expect(revokeUrl).toHaveBeenCalledOnce();
    audios[0]!.emit('ended'); expect(acks).toHaveLength(1);
  });
  it('has a strict bounded private wire allowlist', () => {
    const { command } = setup(); const valid = command();
    expect(isAudioHostCommand(valid)).toBe(true);
    expect(isAudioHostCommand({ ...valid, format: 'wav' })).toBe(true);
    expect(isAudioHostCommand({ ...valid, format: 'mp3' })).toBe(true);
    expect(isAudioHostCommand({ ...valid, format: 'pcm' })).toBe(false);
    expect(isAudioHostCommand({ ...valid, format: undefined })).toBe(false);
    expect(isAudioHostCommand({ ...valid, path: '/etc/passwd' })).toBe(false);
    expect(isAudioHostCommand({ ...valid, bytes: new Uint8Array(8 * 1024 * 1024 + 1) })).toBe(false);
    expect(isAudioHostCommand({ ...valid, bytes: 'base64' })).toBe(false);
    expect(isAudioHostAck({ type: 'ended', token: valid.token, generation: 1 })).toBe(true);
    expect(isAudioHostAck({ type: 'ended', token: valid.token, generation: 1, path: '/private/file' })).toBe(false);
  });
});
