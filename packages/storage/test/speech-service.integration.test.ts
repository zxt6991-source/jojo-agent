import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { SpeechProviderError, SpeechSettingsSchema } from '@desktop-agent/contracts';
import type { AudioAsset, AudioAssetOwner, SpeechAssetStore, SpeechProvider, TtsEvent } from '@desktop-agent/contracts';
import { SpeechService, speechCacheKey } from '@desktop-agent/speech';
import { afterEach, describe, expect, it, vi } from 'vitest';

// A real cross-package integration: the local synthesis process is replaced.
import { SqliteSpeechAssetStore } from '../src/sqlite-speech-asset-store.js';

const SESSION: AudioAssetOwner = { kind: 'session', id: 'integration-session' };
const SCHEDULE: AudioAssetOwner = { kind: 'schedule', id: 'integration-schedule' };
const settings = () => SpeechSettingsSchema.parse({});
const directories: string[] = [];
const stores: SqliteSpeechAssetStore[] = [];
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function storage() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-speech-integration-')); directories.push(directory);
  const filename = path.join(directory, 'speech.sqlite');
  const assets = new SqliteSpeechAssetStore(filename); stores.push(assets);
  return { assets, filename };
}
function fakeProvider(synthesize?: SpeechProvider['tts']['synthesize']) {
  const tts = vi.fn(synthesize ?? (async function* (request): AsyncIterable<TtsEvent> {
    yield { type: 'audio', requestId: request.requestId, bytes: Uint8Array.of(1, 2), format: 'wav', sampleRate: 24000 };
    yield { type: 'audio', requestId: request.requestId, bytes: Uint8Array.of(3, 4), format: 'wav', sampleRate: 24000 };
    yield { type: 'completed', requestId: request.requestId };
  }));
  const provider: SpeechProvider = {
    asr: { recognize() { throw new Error('ASR is outside this synthesis integration.'); } },
    tts: { synthesize: tts }
  };
  return { provider, tts };
}
const input = (text = '你好，Jojo。', owner: AudioAssetOwner = SESSION, signal = new AbortController().signal) => ({ text, owner, signal });
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('SpeechService with real SQLite audio storage', () => {
  it('synthesizes once, persists the real service cache key, and reuses a physical entity for normalized text and independent owners', async () => {
    const { assets, filename } = await storage(); const h = fakeProvider();
    const service = new SpeechService({ provider: h.provider, assets, settings: settings() });
    const first = await service.synthesize(input('**你好，Jojo。**'));
    const cached = await service.synthesize(input('你好，Jojo。', SCHEDULE));
    expect(h.tts).toHaveBeenCalledOnce(); expect(first.id).not.toBe(cached.id);
    expect(cached.owner).toEqual(SCHEDULE);
    const firstReady = (await assets.getReadyAsset(first.id, SESSION))!;
    const cachedReady = (await assets.getReadyAsset(cached.id, SCHEDULE))!;
    expect(firstReady.path).toBe(cachedReady.path);
    expect(readFileSync(firstReady.path)).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(await assets.getReadyAsset(cached.id, SESSION)).toBeUndefined();
    expect(readdirSync(assets.assetsDirectory)).toHaveLength(1);
    const database = new DatabaseSync(filename);
    const entity = database.prepare('SELECT cache_key FROM speech_audio_entities').get(); database.close();
    expect(entity?.cache_key).toBe(await speechCacheKey('你好，Jojo。', settings()));
    expect(entity?.cache_key).toMatch(/^sha256:[0-9a-f]{64}$/u);
    service.dispose();
  });

  it('retains cached synthesis across service restarts without storing text or making another provider attempt', async () => {
    const { assets, filename } = await storage(); const original = fakeProvider();
    const firstService = new SpeechService({ provider: original.provider, assets, settings: settings() });
    const first = await firstService.synthesize(input()); firstService.dispose();
    const changed = fakeProvider();
    const secondService = new SpeechService({ provider: changed.provider, assets, settings: settings() });
    const cached = await secondService.synthesize(input('你好，Jojo。', SCHEDULE));
    expect(original.tts).toHaveBeenCalledOnce();
    expect(changed.tts).not.toHaveBeenCalled();
    expect((await assets.getReadyAsset(first.id, SESSION))!.path).toBe((await assets.getReadyAsset(cached.id, SCHEDULE))!.path);
    const database = new DatabaseSync(filename);
    const persisted = JSON.stringify(database.prepare('SELECT * FROM speech_audio_entities').all()); database.close();
    expect(persisted).not.toContain('你好');
    expect(readdirSync(assets.assetsDirectory)).toHaveLength(1); secondService.dispose();
  });

  it.each(['provider_error', 'truncated'] as const)('cleans actual temporary files when a synthesis ends with %s', async (reason) => {
    const { assets } = await storage(); const h = fakeProvider(async function* (request) {
      yield { type: 'audio', requestId: request.requestId, bytes: Uint8Array.of(1, 2), format: 'wav', sampleRate: 24000 };
      if (reason === 'provider_error') throw new SpeechProviderError('rate_limited', 'Offline provider fixture failed.');
    });
    const service = new SpeechService({ provider: h.provider, assets, settings: settings() });
    await expect(service.synthesize(input())).rejects.toMatchObject({ code: reason === 'provider_error' ? 'rate_limited' : 'protocol_error' });
    expect(await assets.find(await speechCacheKey('你好，Jojo。', settings()), SESSION)).toBeUndefined();
    expect(readdirSync(assets.assetsDirectory)).toEqual([]); expect(h.tts).toHaveBeenCalledOnce(); service.dispose();
  });

  it('rejects late provider completion after cancellation and cleans its real .part file', async () => {
    const { assets } = await storage(); const written = deferred(); const finish = deferred(); const controller = new AbortController();
    const h = fakeProvider(async function* (request) {
      yield { type: 'audio', requestId: request.requestId, bytes: Uint8Array.of(1, 2), format: 'wav', sampleRate: 24000 };
      written.resolve(); await finish.promise; yield { type: 'completed', requestId: request.requestId };
    });
    const service = new SpeechService({ provider: h.provider, assets, settings: settings() });
    const synthesis = service.synthesize(input('你好，Jojo。', SESSION, controller.signal));
    const rejected = expect(synthesis).rejects.toMatchObject({ code: 'cancelled' });
    await written.promise;
    expect(readdirSync(assets.assetsDirectory)).toEqual([expect.stringMatching(/\.part$/u)]);
    expect(await assets.find(await speechCacheKey('你好，Jojo。', settings()), SESSION)).toBeUndefined();
    controller.abort(); finish.resolve(); await rejected;
    expect(readdirSync(assets.assetsDirectory)).toEqual([]);
    expect(await assets.find(await speechCacheKey('你好，Jojo。', settings()), SESSION)).toBeUndefined(); service.dispose();
  });

  it('revokes the actual published reference if cancellation happens while complete() is returning', async () => {
    const { assets } = await storage(); const completing = deferred(); const finish = deferred(); const controller = new AbortController();
    let published: AudioAsset | undefined;
    const delayedAssets: SpeechAssetStore = {
      find: (cacheKey, owner) => assets.find(cacheKey, owner),
      release: (asset) => assets.release(asset),
      releaseOwner: (owner) => assets.releaseOwner(owner), clear: () => assets.clear(),
      begin: async (cacheKey, owner, format) => {
        const writer = await assets.begin(cacheKey, owner, format);
        return { append: (bytes) => writer.append(bytes), abort: () => writer.abort(), complete: async () => {
          published = await writer.complete(); completing.resolve(); await finish.promise; return published;
        } };
      }
    };
    const service = new SpeechService({ provider: fakeProvider().provider, assets: delayedAssets, settings: settings() });
    const synthesis = service.synthesize(input('你好，Jojo。', SESSION, controller.signal));
    const rejected = expect(synthesis).rejects.toMatchObject({ code: 'cancelled' });
    await completing.promise; expect(readdirSync(assets.assetsDirectory)).toEqual([expect.stringMatching(/\.wav$/u)]);
    controller.abort(); finish.resolve(); await rejected;
    expect(await assets.getReadyAsset(published!.id, SESSION)).toBeUndefined();
    expect(await assets.find(await speechCacheKey('你好，Jojo。', settings()), SESSION)).toBeUndefined();
    expect(readdirSync(assets.assetsDirectory)).toEqual([]); service.dispose();
  });

  it('releases a cancelled cache lookup reference without affecting the prior owner reference or entity', async () => {
    const { assets, filename } = await storage(); const h = fakeProvider();
    const service = new SpeechService({ provider: h.provider, assets, settings: settings() });
    const original = await service.synthesize(input());
    const found = deferred(); const finish = deferred(); const controller = new AbortController();
    let cancelledLookup: AudioAsset | undefined;
    const delayedAssets: SpeechAssetStore = {
      find: async (cacheKey, owner) => {
        cancelledLookup = await assets.find(cacheKey, owner); found.resolve(); await finish.promise; return cancelledLookup;
      },
      begin: (cacheKey, owner, format) => assets.begin(cacheKey, owner, format), release: (asset) => assets.release(asset),
      releaseOwner: (owner) => assets.releaseOwner(owner), clear: () => assets.clear()
    };
    const cachedService = new SpeechService({ provider: h.provider, assets: delayedAssets, settings: settings() });
    const pending = cachedService.synthesize(input('你好，Jojo。', SCHEDULE, controller.signal));
    const rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    await found.promise; expect(cancelledLookup).toBeDefined();
    controller.abort(); finish.resolve(); await rejected;
    expect(await assets.getReadyAsset(cancelledLookup!.id, SCHEDULE)).toBeUndefined();
    expect(await assets.getReadyAsset(original.id, SESSION)).toBeDefined();
    const database = new DatabaseSync(filename);
    expect(database.prepare('SELECT count(*) AS count FROM speech_audio_refs').get()?.count).toBe(1);
    expect(database.prepare('SELECT count(*) AS count FROM speech_audio_entities').get()?.count).toBe(1); database.close();
    expect(readdirSync(assets.assetsDirectory)).toHaveLength(1); expect(h.tts).toHaveBeenCalledOnce();
    cachedService.dispose(); service.dispose();
  });
});
