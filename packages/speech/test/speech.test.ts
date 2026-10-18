import { createHash } from 'node:crypto';
import {
  SpeechSettingsSchema, SPEECH_TEXT_VERSION, SPEECH_PROTOCOL_VERSION, SpeechProviderError,
  type AudioAsset, type AudioAssetWriter, type AsrEvent, type SpeechAssetStore, type SpeechProvider,
  type TtsEvent, type SpeechSettings
} from '@desktop-agent/contracts';
import { describe, expect, it, vi } from 'vitest';

import { SpeechService, speechCacheKey } from '../src/service.js';
import { normalizeSpeechText } from '../src/text.js';

const owner = { kind: 'test', id: 'speech-offline' } as const;
const asset: AudioAsset = {
  id: '767777f5-e345-4715-983f-9d4dfcc8b7b2', owner, format: 'wav', sampleRate: 24000,
  bytes: 5, createdAt: 1000, expiresAt: 10_000
};
const settings = () => SpeechSettingsSchema.parse({});
const input = (text = '你好，Jojo。', signal = new AbortController().signal) => ({ text, owner, signal });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function harness(tts?: SpeechProvider['tts']['synthesize'], asr?: SpeechProvider['asr']['recognize'], config: SpeechSettings = settings()) {
  const writer: AudioAssetWriter = {
    append: vi.fn(async () => undefined), complete: vi.fn(async () => asset), abort: vi.fn(async () => undefined)
  };
  const assets: SpeechAssetStore = {
    find: vi.fn(async () => undefined), begin: vi.fn(async () => writer), release: vi.fn(async () => undefined), releaseOwner: vi.fn(async () => undefined), clear: vi.fn(async () => undefined)
  };
  const provider: SpeechProvider = {
    asr: { recognize: vi.fn(asr ?? (async function* (request: Parameters<SpeechProvider['asr']['recognize']>[0]): AsyncIterable<AsrEvent> { yield { type: 'ready', requestId: request.requestId }; yield { type: 'final', requestId: request.requestId, text: '你好' }; })) },
    tts: { synthesize: vi.fn(tts ?? (async function* (request: Parameters<SpeechProvider['tts']['synthesize']>[0]): AsyncIterable<TtsEvent> {
      yield { type: 'audio', requestId: request.requestId, bytes: Uint8Array.of(1, 2), format: 'wav', sampleRate: 24000 };
      yield { type: 'completed', requestId: request.requestId };
    })) }
  };
  return { writer, assets, provider, service: new SpeechService({ provider, assets, settings: config }) };
}
async function collect<T>(events: AsyncIterable<T>): Promise<T[]> { const result: T[] = []; for await (const event of events) result.push(event); return result; }

describe('deterministic readable speech text', () => {
  it('normalizes Markdown, links, tables, code, URLs, whitespace and Unicode', () => {
    const text = '# 你好\n\n> **欢迎** [Jojo](https://example.test)\n```ts\nsecret()\n```\n![image](https://example.test/image)\n| Header | Value |\n| --- | --- |\n1. e\u0301 `测试`\nhttps://example.test/unused\n';
    expect(normalizeSpeechText(text)).toBe('你好 欢迎 Jojo é 测试');
    expect(text).toContain('secret()');
  });
  it('defaults to 600 Unicode code points without splitting emoji, and supports the 200-character reminder bound', () => {
    expect(Array.from(normalizeSpeechText('🙂'.repeat(650)))).toHaveLength(600);
    expect(normalizeSpeechText('水'.repeat(300), 200)).toBe('水'.repeat(200));
    expect(normalizeSpeechText(' \n ```ts\nconst a = 1;\n``` \n')).toBe('');
  });
  it.each([0, -1, 1.5, Infinity, 10_001])('rejects an invalid output limit %s', (limit) => {
    expect(() => normalizeSpeechText('hello', limit)).toThrow('Invalid speech text limit');
  });
});

describe('speech cache identity', () => {
  it('isolates a neural model location and voice from system speech and other local models', async () => {
    const first = SpeechSettingsSchema.parse({ provider: { tts: { id: 'mlx-qwen3', local: { pythonPath: '/local/python3', modelDirectory: '/local/model-a' } } } });
    const second = structuredClone(first); second.provider.tts.local!.modelDirectory = '/local/model-b';
    expect(await speechCacheKey('你好', first)).not.toBe(await speechCacheKey('你好', second));
    expect(await speechCacheKey('你好', first)).not.toBe(await speechCacheKey('你好', settings()));
    second.provider.tts.local!.modelDirectory = '/local/model-a'; second.provider.tts.speakerId = 'Vivian';
    expect(await speechCacheKey('你好', first)).not.toBe(await speechCacheKey('你好', second));
  });
  it('hashes canonical text and all model/audio/version dimensions, without clear text in the key', async () => {
    const config = settings(); const text = normalizeSpeechText('**你好** Jojo'); const { tts } = config.provider;
    const expected = createHash('sha256').update(JSON.stringify([
      text, tts.id, tts.speakerId, tts.speechRate, tts.format, tts.sampleRate,
      SPEECH_TEXT_VERSION, SPEECH_PROTOCOL_VERSION
    ])).digest('hex');
    expect(await speechCacheKey(text, config)).toBe(`sha256:${expected}`);
    expect(await speechCacheKey(text, config)).not.toContain(text);
  });
  it.each(['id', 'speakerId', 'speechRate', 'format', 'sampleRate'] as const)('changes when %s changes', async (dimension) => {
    const first = settings(); const second = settings();
    // Future local adapter formats are used to exercise identity; live settings still reject them.
    const values = { id: 'future-local-tts', speakerId: 'different-speaker', speechRate: 25, format: 'pcm', sampleRate: 48000 };
    Object.assign(second.provider.tts, { [dimension]: values[dimension] });
    expect(await speechCacheKey('hello', first)).not.toBe(await speechCacheKey('hello', second));
  });
  it('changes with text and ignores unrelated playback/input policy', async () => {
    const first = settings(); const second = settings(); second.inputMode = 'auto_send'; second.autoReadReplies = true; second.playback.volume = 0.2;
    expect(await speechCacheKey('hello', first)).toBe(await speechCacheKey('hello', second));
    expect(await speechCacheKey('hello', first)).not.toBe(await speechCacheKey('different', first));
  });
});

describe('platform-neutral speech synthesis orchestration', () => {
  it('publishes the selected local WAV format and passes it to the asset store', async () => {
    const config = SpeechSettingsSchema.parse({ provider: { tts: { id: 'macos', format: 'wav', speakerId: 'default' } } });
    const h = harness(async function* (request) {
      yield { type: 'audio', requestId: request.requestId, bytes: Uint8Array.of(1, 2), format: 'wav', sampleRate: 24000 };
      yield { type: 'completed', requestId: request.requestId };
    }, undefined, config);
    const wav = { ...asset, format: 'wav' as const }; vi.mocked(h.writer.complete).mockResolvedValue(wav);
    expect(await h.service.synthesize(input())).toBe(wav);
    expect(h.assets.begin).toHaveBeenCalledExactlyOnceWith(await speechCacheKey('你好，Jojo。', config), owner, 'wav');
  });
  it('rejects an MP3 event from a provider configured to produce WAV and aborts partial output', async () => {
    const config = SpeechSettingsSchema.parse({ provider: { tts: { id: 'macos', format: 'wav', speakerId: 'default' } } });
    const h = harness(async function* (request) {
      yield { type: 'audio', requestId: request.requestId, bytes: Uint8Array.of(1, 2), format: 'mp3', sampleRate: 24000 };
      yield { type: 'completed', requestId: request.requestId };
    }, undefined, config);
    await expect(h.service.synthesize(input())).rejects.toMatchObject({ code: 'protocol_error' });
    expect(h.writer.abort).toHaveBeenCalledOnce(); expect(h.writer.complete).not.toHaveBeenCalled();
  });
  it('rejects and releases a cached reference with a different declared format', async () => {
    const h = harness(); const incompatible = { ...asset, format: 'mp3' as const }; vi.mocked(h.assets.find).mockResolvedValue(incompatible);
    await expect(h.service.synthesize(input())).rejects.toMatchObject({ code: 'protocol_error' });
    expect(h.assets.release).toHaveBeenCalledExactlyOnceWith(incompatible); expect(h.provider.tts.synthesize).not.toHaveBeenCalled();
  });
  it('passes normalized text and owner-scoped identity to storage and returns only a completed asset', async () => {
    const h = harness(); expect(await h.service.synthesize(input('**你好，Jojo。**'))).toBe(asset);
    expect(h.provider.tts.synthesize).toHaveBeenCalledWith(expect.objectContaining({ text: '你好，Jojo。', speakerId: settings().provider.tts.speakerId, speechRate: 0 }));
    expect(h.assets.find).toHaveBeenCalledWith(await speechCacheKey('你好，Jojo。', settings()), owner);
    expect(h.writer.append).toHaveBeenCalledWith(Uint8Array.of(1, 2)); expect(h.writer.complete).toHaveBeenCalledOnce(); expect(h.writer.abort).not.toHaveBeenCalled();
  });
  it('hits a ready cache without opening a writer or making a provider attempt', async () => {
    const h = harness(); vi.mocked(h.assets.find).mockResolvedValue(asset);
    expect(await h.service.synthesize(input())).toBe(asset);
    expect(h.assets.begin).not.toHaveBeenCalled(); expect(h.provider.tts.synthesize).not.toHaveBeenCalled();
  });
  it('makes a fresh local voice test even when the same text has cached audio', async () => {
    const h = harness(); vi.mocked(h.assets.find).mockResolvedValue(asset);
    expect(await h.service.synthesize({ ...input(), forceProvider: true })).toBe(asset);
    expect(h.assets.find).not.toHaveBeenCalled(); expect(h.provider.tts.synthesize).toHaveBeenCalledOnce(); expect(h.writer.complete).toHaveBeenCalledOnce();
  });
  it('does not substitute cached audio when a fresh local voice test fails', async () => {
    const h = harness(async function* (request) {
      yield { type: 'audio', requestId: request.requestId, bytes: Uint8Array.of(1,2), format: 'wav', sampleRate: 24000 };
      throw new SpeechProviderError('local_unavailable', 'The selected system voice is unavailable.');
    });
    vi.mocked(h.assets.find).mockResolvedValue(asset);
    await expect(h.service.synthesize({ ...input(), forceProvider: true })).rejects.toMatchObject({ code: 'local_unavailable' });
    expect(h.assets.find).not.toHaveBeenCalled(); expect(h.provider.tts.synthesize).toHaveBeenCalledOnce(); expect(h.writer.abort).toHaveBeenCalledOnce(); expect(h.writer.complete).not.toHaveBeenCalled();
  });
  it('revokes only the cached reference created during a cancelled lookup and never returns it', async () => {
    const h = harness(); const controller = new AbortController(); const lookupStarted = deferred<void>(); const lookupResult = deferred<AudioAsset>();
    vi.mocked(h.assets.find).mockImplementation(async () => { lookupStarted.resolve(); return await lookupResult.promise; });
    const run = h.service.synthesize(input('hello', controller.signal)); const rejection = expect(run).rejects.toMatchObject({ code: 'cancelled' });
    await lookupStarted.promise; controller.abort(); lookupResult.resolve(asset); await rejection;
    expect(h.assets.release).toHaveBeenCalledExactlyOnceWith(asset); expect(h.assets.releaseOwner).not.toHaveBeenCalled();
    expect(h.assets.begin).not.toHaveBeenCalled(); expect(h.provider.tts.synthesize).not.toHaveBeenCalled();
  });
  it('does not revoke an unrelated asset when a cancelled lookup returns a cache miss', async () => {
    const h = harness(); const controller = new AbortController(); const lookupStarted = deferred<void>(); const lookupResult = deferred<AudioAsset | undefined>();
    vi.mocked(h.assets.find).mockImplementation(async () => { lookupStarted.resolve(); return await lookupResult.promise; });
    const run = h.service.synthesize(input('hello', controller.signal)); const rejection = expect(run).rejects.toMatchObject({ code: 'cancelled' });
    await lookupStarted.promise; controller.abort(); lookupResult.resolve(undefined); await rejection;
    expect(h.assets.release).not.toHaveBeenCalled(); expect(h.assets.releaseOwner).not.toHaveBeenCalled(); expect(h.assets.begin).not.toHaveBeenCalled();
  });
  it('reuses canonical audio identity while retrieving a separate authorized reference for each owner', async () => {
    const h = harness(); let references = 0;
    vi.mocked(h.assets.find).mockImplementation(async (_key, requestedOwner) => ({
      ...asset, owner: requestedOwner, id: references++ ? 'f9fc0437-47d7-4293-ad96-28bde41c6d6c' : asset.id
    }));
    const first = await h.service.synthesize(input('**你好**'));
    const secondOwner = { kind: 'schedule', id: 'other-owner' } as const;
    const second = await h.service.synthesize({ ...input('你好'), owner: secondOwner });
    expect(first.owner).toEqual(owner); expect(second.owner).toEqual(secondOwner); expect(first.id).not.toBe(second.id);
    const lookups = vi.mocked(h.assets.find).mock.calls; expect(lookups[0]?.[0]).toBe(lookups[1]?.[0]);
    expect(h.assets.begin).not.toHaveBeenCalled(); expect(h.provider.tts.synthesize).not.toHaveBeenCalled(); expect(h.assets.release).not.toHaveBeenCalled();
  });
  it('uses the same normalized key across equivalent sources and binds lookup authorization to each owner', async () => {
    const h = harness(); await h.service.synthesize(input('**你好**')); await h.service.synthesize({ ...input('你好'), owner: { kind: 'session', id: 'other-owner' } });
    const calls = vi.mocked(h.assets.find).mock.calls; expect(calls[0]?.[0]).toBe(calls[1]?.[0]);
    expect(calls[0]?.[1]).toEqual(owner); expect(calls[1]?.[1]).toEqual({ kind: 'session', id: 'other-owner' });
  });
  it('never publishes partial audio, even after receiving completed until the provider iterable settles normally', async () => {
    const wroteAudio = deferred<void>(); const allowCompleted = deferred<void>(); const gotCompleted = deferred<void>(); const finish = deferred<void>();
    const h = harness(async function* (request) {
      yield { type: 'audio', requestId: request.requestId, bytes: Uint8Array.of(1), format: 'wav', sampleRate: 24000 };
      wroteAudio.resolve(); await allowCompleted.promise; yield { type: 'completed', requestId: request.requestId };
      gotCompleted.resolve(); await finish.promise;
    });
    const run = h.service.synthesize(input()); await wroteAudio.promise; expect(h.writer.complete).not.toHaveBeenCalled();
    allowCompleted.resolve(); await gotCompleted.promise; expect(h.writer.complete).not.toHaveBeenCalled();
    finish.resolve(); expect(await run).toBe(asset); expect(h.writer.complete).toHaveBeenCalledOnce();
  });
  it('does not retry failed provider attempts and aborts partial assets', async () => {
    const h = harness(async function* (request) {
      yield { type: 'audio', requestId: request.requestId, bytes: Uint8Array.of(1), format: 'wav', sampleRate: 24000 };
      throw new SpeechProviderError('rate_limited', 'Controlled reason', { retryable: true });
    });
    await expect(h.service.synthesize(input())).rejects.toMatchObject({ code: 'rate_limited' });
    expect(h.provider.tts.synthesize).toHaveBeenCalledOnce(); expect(h.writer.abort).toHaveBeenCalledOnce(); expect(h.writer.complete).not.toHaveBeenCalled();
  });
  it('rejects stream exhaustion before completed', async () => {
    const h = harness(async function* (request) { yield { type: 'audio', requestId: request.requestId, bytes: Uint8Array.of(1), format: 'wav', sampleRate: 24000 }; });
    await expect(h.service.synthesize(input())).rejects.toMatchObject({ code: 'protocol_error' }); expect(h.writer.abort).toHaveBeenCalledOnce(); expect(h.writer.complete).not.toHaveBeenCalled();
  });
  it.each(['wrong_request', 'after_completed', 'wrong_format'] as const)('rejects %s events before ready publication', async (failure) => {
    const h = harness(async function* (request) {
      if (failure === 'wrong_request') yield { type: 'completed', requestId: 'stale-attempt' };
      else if (failure === 'after_completed') { yield { type: 'completed', requestId: request.requestId }; yield { type: 'completed', requestId: request.requestId }; }
      else yield { type: 'audio', requestId: request.requestId, bytes: Uint8Array.of(1), format: 'pcm', sampleRate: 16000 } as unknown as TtsEvent;
    });
    await expect(h.service.synthesize(input())).rejects.toMatchObject({ code: 'protocol_error' }); expect(h.writer.abort).toHaveBeenCalledOnce(); expect(h.writer.complete).not.toHaveBeenCalled();
  });
  it('rejects pre-cancellation and empty normalized text without storage/provider activity', async () => {
    const h = harness(); await expect(h.service.synthesize(input('hello', AbortSignal.abort()))).rejects.toMatchObject({ code: 'cancelled' });
    await expect(h.service.synthesize(input('```ts\nonly code\n```'))).rejects.toMatchObject({ code: 'empty_result' });
    expect(h.assets.find).not.toHaveBeenCalled(); expect(h.assets.begin).not.toHaveBeenCalled(); expect(h.provider.tts.synthesize).not.toHaveBeenCalled();
  });
  it('cancels after audio append, rejects late completed and aborts the writer', async () => {
    const controller = new AbortController(); const appendStarted = deferred<void>(); const finish = deferred<void>();
    const h = harness(async function* (request) {
      yield { type: 'audio', requestId: request.requestId, bytes: Uint8Array.of(1), format: 'wav', sampleRate: 24000 };
      appendStarted.resolve(); await finish.promise; yield { type: 'completed', requestId: request.requestId };
    });
    const run = h.service.synthesize(input('hello', controller.signal)); const rejection = expect(run).rejects.toMatchObject({ code: 'cancelled' });
    await appendStarted.promise; controller.abort(); finish.resolve(); await rejection;
    expect(h.writer.complete).not.toHaveBeenCalled(); expect(h.writer.abort).toHaveBeenCalledOnce();
  });
  it('rejects late asset publication when cancelled during asynchronous writer completion', async () => {
    const controller = new AbortController(); const completing = deferred<void>(); const finish = deferred<void>();
    const h = harness();
    vi.mocked(h.writer.complete).mockImplementation(async () => { completing.resolve(); await finish.promise; return asset; });
    const run = h.service.synthesize(input('hello', controller.signal));
    const rejection = expect(run).rejects.toMatchObject({ code: 'cancelled' });
    await completing.promise; controller.abort(); finish.resolve(); await rejection;
  });
  it('dispose aborts all active signals, rejects late completion, and rejects future calls', async () => {
    const entered = deferred<void>(); const finish = deferred<void>(); let activeSignal!: AbortSignal;
    const h = harness(async function* (request) { activeSignal = request.signal; entered.resolve(); await finish.promise; yield { type: 'completed', requestId: request.requestId }; });
    const run = h.service.synthesize(input()); const rejection = expect(run).rejects.toMatchObject({ code: 'cancelled' });
    await entered.promise; h.service.dispose(); expect(activeSignal.aborted).toBe(true); finish.resolve(); await rejection;
    expect(h.writer.abort).toHaveBeenCalledOnce(); expect(h.writer.complete).not.toHaveBeenCalled();
    await expect(h.service.synthesize(input())).rejects.toMatchObject({ code: 'cancelled' });
  });
  it('generates a fresh UUID for every actual provider attempt', async () => {
    const h = harness(); await h.service.synthesize(input()); await h.service.synthesize(input());
    const ids = vi.mocked(h.provider.tts.synthesize).mock.calls.map(([request]) => request.requestId);
    expect(ids).toHaveLength(2); expect(ids[0]).not.toBe(ids[1]);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u);
    const signals = vi.mocked(h.provider.tts.synthesize).mock.calls.map(([request]) => request.signal); expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
});

describe('ASR orchestration lifecycle', () => {
  async function* audio() { yield Uint8Array.of(0, 0); }
  it('preserves audio, the fixed input format, and event snapshots; assigns a fresh UUID per call', async () => {
    const h = harness(); const events = await collect(h.service.recognize(audio(), new AbortController().signal));
    await collect(h.service.recognize(audio(), new AbortController().signal)); expect(events.map((event) => event.type)).toEqual(['ready', 'final']);
    const calls = vi.mocked(h.provider.asr.recognize).mock.calls;
    expect(calls[0]?.[0].format).toEqual({ codec: 'pcm16le', sampleRate: 16000, channels: 1 }); expect(calls[0]?.[0].requestId).not.toBe(calls[1]?.[0].requestId);
    expect(calls.every(([request]) => request.signal.aborted)).toBe(true);
  });
  it('closes the provider scope when a consumer stops after ready', async () => {
    let closed = false; let activeSignal!: AbortSignal;
    const h = harness(undefined, async function* (request): AsyncIterable<AsrEvent> { activeSignal = request.signal; try { yield { type: 'ready', requestId: request.requestId }; } finally { closed = true; } });
    const iterator = h.service.recognize(audio(), new AbortController().signal)[Symbol.asyncIterator](); await iterator.next(); await iterator.return?.();
    expect(activeSignal.aborted).toBe(true); expect(closed).toBe(true);
  });
});
