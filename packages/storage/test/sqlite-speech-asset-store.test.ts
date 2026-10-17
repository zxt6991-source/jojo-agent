import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { AudioAssetOwner } from '@desktop-agent/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { createSilentWavFixture } from '../../../apps/desktop/src/testing/speech-audio-fixture';

import { SqliteSpeechAssetStore } from '../src/sqlite-speech-asset-store.js';
import type { SqliteSpeechAssetStoreOptions } from '../src/sqlite-speech-asset-store.js';

const SESSION: AudioAssetOwner = { kind: 'session', id: 'session-a' };
const SCHEDULE: AudioAssetOwner = { kind: 'schedule', id: 'schedule-a' };
const TEST: AudioAssetOwner = { kind: 'test', id: 'test-a' };
const key = (value: number) => `sha256:${value.toString(16).padStart(64, '0')}`;
const directories: string[] = [];
const stores: SqliteSpeechAssetStore[] = [];
async function create(options: SqliteSpeechAssetStoreOptions = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-speech-assets-'));
  directories.push(directory);
  const filename = path.join(directory, 'speech.sqlite');
  const store = new SqliteSpeechAssetStore(filename, options); stores.push(store);
  return { directory, filename, store };
}
async function publish(store: SqliteSpeechAssetStore, cacheKey: string, owner = SESSION, bytes = Uint8Array.from([1, 2, 3])) {
  const writer = await store.begin(cacheKey, owner); await writer.append(bytes); return writer.complete();
}
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('SqliteSpeechAssetStore', () => {
  it('persists real WAV bytes, format, suffix and independent owner references across restart', async () => {
    const { store, filename } = await create(); const bytes = createSilentWavFixture();
    const writer = await store.begin(key(30), SESSION, 'wav'); await writer.append(bytes);
    const asset = await writer.complete(); const ready = (await store.getReadyAsset(asset.id, SESSION))!;
    expect(asset).toMatchObject({ format: 'wav', sampleRate: 24000, bytes: bytes.byteLength });
    expect(ready.path).toMatch(/\.wav$/u); expect(readFileSync(ready.path)).toEqual(Buffer.from(bytes));
    store.close(); const reopened = new SqliteSpeechAssetStore(filename); stores.push(reopened);
    expect((await reopened.getReadyAsset(asset.id, SESSION))!.asset).toEqual(asset);
    const scheduled = (await reopened.find(key(30), SCHEDULE))!;
    expect(scheduled).toMatchObject({ format: 'wav', owner: SCHEDULE });
    expect((await reopened.getReadyAsset(scheduled.id, SCHEDULE))!.path).toBe(ready.path);
    await reopened.releaseOwner(SESSION); expect(await reopened.getReadyAsset(scheduled.id, SCHEDULE)).toBeDefined();
    await reopened.releaseOwner(SCHEDULE); expect(readdirSync(reopened.assetsDirectory)).toEqual([]);
  });

  it('migrates the legacy schema 1 without deleting MP3 bytes, metadata or owner references', async () => {
    const { store, filename } = await create(); const original = await publish(store, key(31));
    const ready = (await store.getReadyAsset(original.id, SESSION))!; store.close();
    const legacy = new DatabaseSync(filename);
    legacy.exec('ALTER TABLE speech_audio_entities DROP COLUMN format;');
    legacy.prepare("UPDATE speech_asset_meta SET value = '1' WHERE key = 'schema_version'").run(); legacy.close();
    const migrated = new SqliteSpeechAssetStore(filename); stores.push(migrated);
    expect((await migrated.getReadyAsset(original.id, SESSION))!).toEqual(ready);
    expect(readFileSync(ready.path)).toEqual(Buffer.from([1, 2, 3]));
    expect(await migrated.find(key(31), SCHEDULE)).toMatchObject({ format: 'mp3', bytes: 3 });
    const database = new DatabaseSync(filename);
    expect(database.prepare("SELECT value FROM speech_asset_meta WHERE key = 'schema_version'").get()?.value).toBe('2'); database.close();
    const wav = await migrated.begin(key(32), TEST, 'wav'); await wav.append(createSilentWavFixture());
    expect(await wav.complete()).toMatchObject({ format: 'wav' });
  });

  it('rejects invalid formats and cross-format cache collisions without changing the existing asset', async () => {
    const { store } = await create(); const original = await publish(store, key(33));
    await expect(store.begin(key(34), SESSION, 'pcm' as 'wav')).rejects.toMatchObject({ code: 'protocol_error' });
    const writer = await store.begin(key(33), SCHEDULE, 'wav'); await writer.append(createSilentWavFixture());
    await expect(writer.complete()).rejects.toMatchObject({ code: 'protocol_error' });
    expect((await store.getReadyAsset(original.id, SESSION))!.asset).toEqual(original);
    expect(readdirSync(store.assetsDirectory)).toEqual([expect.stringMatching(/\.mp3$/u)]);
  });
  it('keeps partial audio invisible and publishes only an atomic ready file with private permissions', async () => {
    const { store } = await create(); const writer = await store.begin(key(1), SESSION);
    const [temporary] = readdirSync(store.assetsDirectory);
    expect(temporary).toMatch(/^[0-9a-f-]{36}\.part$/u);
    expect(lstatSync(path.join(store.assetsDirectory, temporary!)).mode & 0o777).toBe(0o600);
    await writer.append(Uint8Array.from([1, 2]));
    expect(await store.find(key(1), SESSION)).toBeUndefined();
    await writer.append(Uint8Array.from([3, 4]));
    const asset = await writer.complete();
    const ready = await store.getReadyAsset(asset.id, SESSION);
    expect(ready?.asset).toEqual(asset);
    expect(asset).toMatchObject({ owner: SESSION, bytes: 4, format: 'mp3', sampleRate: 24000 });
    expect(ready?.path).toMatch(/^[\s\S]+\/[0-9a-f-]{36}\.mp3$/u);
    expect(readFileSync(ready!.path)).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(lstatSync(ready!.path).mode & 0o777).toBe(0o600);
    expect(readdirSync(store.assetsDirectory)).toHaveLength(1);
    expect(await writer.complete()).toEqual(asset);
  });

  it('deduplicates entities while granting independent opaque references and enforcing exact owners', async () => {
    const { store } = await create(); const original = await publish(store, key(2));
    const schedule = await store.find(key(2), SCHEDULE); const test = await store.find(key(2), TEST);
    const anotherSession = await store.find(key(2), SESSION);
    expect(new Set([original.id, schedule!.id, test!.id, anotherSession!.id]).size).toBe(4);
    const paths = await Promise.all([
      store.getReadyAsset(original.id, SESSION), store.getReadyAsset(schedule!.id, SCHEDULE), store.getReadyAsset(test!.id, TEST)
    ]);
    expect(new Set(paths.map((item) => item!.path)).size).toBe(1);
    expect(readdirSync(store.assetsDirectory)).toHaveLength(1);
    expect(await store.getReadyAsset(original.id, SCHEDULE)).toBeUndefined();
    expect(await store.getReadyAsset(original.id, { kind: 'session', id: 'session-b' })).toBeUndefined();
    expect(await store.getReadyAsset(original.id, { kind: 'test', id: SESSION.id })).toBeUndefined();
    expect(await store.getReadyAsset(randomUUID(), SESSION)).toBeUndefined();
    expect(await store.getReadyAsset('../../secret.mp3', SESSION)).toBeUndefined();
  });

  it('releases one owner and removes the entity only after all its references are gone', async () => {
    const { store } = await create(); const session = await publish(store, key(3));
    const schedule = await store.find(key(3), SCHEDULE);
    const ready = await store.getReadyAsset(schedule!.id, SCHEDULE);
    await store.releaseOwner(SESSION);
    expect(await store.getReadyAsset(session.id, SESSION)).toBeUndefined();
    expect(await store.getReadyAsset(schedule!.id, SCHEDULE)).toBeDefined();
    expect(readFileSync(ready!.path)).toEqual(Buffer.from([1, 2, 3]));
    await store.releaseOwner(SCHEDULE);
    expect(await store.find(key(3), TEST)).toBeUndefined();
    expect(readdirSync(store.assetsDirectory)).toEqual([]);
  });

  it('releases only the matching asset reference, rejects cross-owner attempts and is idempotent', async () => {
    const { store } = await create(); const original = await publish(store, key(26));
    const sameOwner = (await store.find(key(26), SESSION))!;
    const otherOwner = (await store.find(key(26), SCHEDULE))!;
    await expect(store.release({ ...original, owner: SCHEDULE })).rejects.toMatchObject({ code: 'resource_denied' });
    await expect(store.release({ ...original, owner: { kind: 'session', id: 'wrong-session' } })).rejects.toMatchObject({ code: 'resource_denied' });
    expect(await store.getReadyAsset(original.id, SESSION)).toBeDefined();
    await store.release(original); await store.release(original);
    expect(await store.getReadyAsset(original.id, SESSION)).toBeUndefined();
    expect(await store.getReadyAsset(sameOwner.id, SESSION)).toBeDefined();
    expect(await store.getReadyAsset(otherOwner.id, SCHEDULE)).toBeDefined();
    await store.release(sameOwner); expect(readdirSync(store.assetsDirectory)).toHaveLength(1);
    await store.release(otherOwner); await store.release(otherOwner);
    expect(readdirSync(store.assetsDirectory)).toEqual([]);
  });

  it('handles concurrent cache-key writers without duplicate files or shared authorization tokens', async () => {
    const { store } = await create();
    const first = await store.begin(key(4), SESSION); const second = await store.begin(key(4), SCHEDULE);
    await Promise.all([first.append(Uint8Array.from([1, 2, 3])), second.append(Uint8Array.from([4, 5, 6, 7]))]);
    const [a, b] = await Promise.all([first.complete(), second.complete()]);
    expect(a.id).not.toBe(b.id); expect(a.bytes).toBe(3); expect(b.bytes).toBe(3);
    expect((await store.getReadyAsset(a.id, SESSION))!.path).toBe((await store.getReadyAsset(b.id, SCHEDULE))!.path);
    expect(readdirSync(store.assetsDirectory)).toHaveLength(1);
  });

  it('rolls back an empty result, oversized accumulated audio and explicit cancellation', async () => {
    const { store } = await create({ maxAssetBytes: 4 });
    const empty = await store.begin(key(5), SESSION);
    await expect(empty.complete()).rejects.toMatchObject({ code: 'empty_result' });
    const oversized = await store.begin(key(6), SESSION); await oversized.append(Uint8Array.from([1, 2, 3]));
    await expect(oversized.append(Uint8Array.from([4, 5]))).rejects.toMatchObject({ code: 'protocol_error' });
    await expect(oversized.complete()).rejects.toMatchObject({ code: 'cancelled' });
    const cancelled = await store.begin(key(7), SESSION); await cancelled.append(Uint8Array.from([1, 2]));
    await cancelled.abort(); await cancelled.abort();
    await expect(cancelled.complete()).rejects.toMatchObject({ code: 'cancelled' });
    expect(await store.find(key(5), SESSION)).toBeUndefined();
    expect(await store.find(key(6), SESSION)).toBeUndefined();
    expect(await store.find(key(7), SESSION)).toBeUndefined(); expect(readdirSync(store.assetsDirectory)).toEqual([]);
  });

  it('cleans a failed atomic rename without exposing the completed audio', async () => {
    const { store } = await create(); const writer = await store.begin(key(8), SESSION);
    await writer.append(Uint8Array.from([1, 2, 3]));
    const temporary = readdirSync(store.assetsDirectory)[0]!;
    const blockedDestination = path.join(store.assetsDirectory, temporary.replace(/\.part$/u, '.mp3'));
    mkdirSync(blockedDestination);
    await expect(writer.complete()).rejects.toMatchObject({ code: 'protocol_error' });
    expect(await store.find(key(8), SESSION)).toBeUndefined();
    expect(readdirSync(store.assetsDirectory)).toEqual([path.basename(blockedDestination)]);
    rmSync(blockedDestination, { recursive: true });
  });

  it('allows post-completion abort to revoke only that writer reference, preserving an existing same-owner cache reference', async () => {
    const { store } = await create(); const existing = await publish(store, key(9));
    const writer = await store.begin(key(9), SESSION); await writer.append(Uint8Array.from([5, 6]));
    const completed = await writer.complete();
    expect(completed.id).not.toBe(existing.id);
    await writer.abort(); await writer.abort();
    expect(await store.getReadyAsset(completed.id, SESSION)).toBeUndefined();
    expect(await store.getReadyAsset(existing.id, SESSION)).toBeDefined(); expect(readdirSync(store.assetsDirectory)).toHaveLength(1);
    const sole = await store.begin(key(10), TEST); await sole.append(Uint8Array.from([1]));
    const unique = await sole.complete(); await sole.abort();
    expect(await store.getReadyAsset(unique.id, TEST)).toBeUndefined(); expect(await store.find(key(10), TEST)).toBeUndefined();
  });

  it('invalidates old writers on clear and lets new writes publish without resurrecting old refs', async () => {
    const { store } = await create(); const completedWriter = await store.begin(key(11), SESSION);
    await completedWriter.append(Uint8Array.from([1])); const published = await completedWriter.complete();
    const writer = await store.begin(key(12), SCHEDULE); await writer.append(Uint8Array.from([2]));
    const clearing = store.clear(); const attemptedLatePublish = writer.complete();
    await clearing; await expect(attemptedLatePublish).rejects.toMatchObject({ code: 'cancelled' });
    await expect(writer.append(Uint8Array.from([3]))).rejects.toMatchObject({ code: 'cancelled' });
    await completedWriter.abort();
    await expect(completedWriter.complete()).rejects.toMatchObject({ code: 'cancelled' });
    expect(await store.getReadyAsset(published.id, SESSION)).toBeUndefined(); expect(readdirSync(store.assetsDirectory)).toEqual([]);
    const replacement = await publish(store, key(12), SCHEDULE);
    expect(await store.getReadyAsset(replacement.id, SCHEDULE)).toBeDefined();
  });

  it('prevents an owner-deleted in-flight writer from restoring its authorization', async () => {
    const { store } = await create(); const writer = await store.begin(key(13), SESSION);
    await writer.append(Uint8Array.from([1])); await store.releaseOwner(SESSION);
    await expect(writer.complete()).rejects.toMatchObject({ code: 'cancelled' });
    expect(await store.find(key(13), TEST)).toBeUndefined(); expect(readdirSync(store.assetsDirectory)).toEqual([]);
  });

  it('persists ready metadata and references across restart and removes incomplete writers on close', async () => {
    const { store, filename } = await create(); const asset = await publish(store, key(14));
    const unfinished = await store.begin(key(15), TEST); await unfinished.append(Uint8Array.from([1]));
    store.close(); store.close(); await expect(unfinished.complete()).rejects.toMatchObject({ code: 'cancelled' });
    await expect(store.find(key(14), SESSION)).rejects.toMatchObject({ code: 'cancelled' });
    const reopened = new SqliteSpeechAssetStore(filename); stores.push(reopened);
    expect((await reopened.getReadyAsset(asset.id, SESSION))!.asset).toEqual(asset);
    expect(await reopened.find(key(14), SCHEDULE)).toMatchObject({ owner: SCHEDULE, bytes: 3 });
    expect(await reopened.find(key(15), TEST)).toBeUndefined(); expect(readdirSync(reopened.assetsDirectory)).toHaveLength(1);
  });

  it('expires cache entities after their age limit, including on startup', async () => {
    let now = 1000; const options = { cacheAgeMs: 100, now: () => now };
    const { store, filename } = await create(options); const asset = await publish(store, key(16));
    now = 1099; expect(await store.find(key(16), SCHEDULE)).toBeDefined();
    now = 1100; expect(await store.getReadyAsset(asset.id, SESSION)).toBeUndefined();
    expect(readdirSync(store.assetsDirectory)).toEqual([]);
    now = 2000; const later = await publish(store, key(17)); store.close(); now = 2100;
    const reopened = new SqliteSpeechAssetStore(filename, options); stores.push(reopened);
    expect(await reopened.getReadyAsset(later.id, SESSION)).toBeUndefined(); expect(readdirSync(reopened.assetsDirectory)).toEqual([]);
  });

  it('counts each physical entity once and evicts least recently accessed files at the quota', async () => {
    let now = 1000; const { store } = await create({ maxCacheBytes: 6, now: () => now });
    const a = await publish(store, key(18)); now++;
    const b = await publish(store, key(19)); now++;
    const duplicate = await store.find(key(18), SCHEDULE);
    expect(readdirSync(store.assetsDirectory)).toHaveLength(2); now++;
    const c = await publish(store, key(20));
    expect(await store.getReadyAsset(b.id, SESSION)).toBeUndefined();
    expect(await store.getReadyAsset(a.id, SESSION)).toBeDefined();
    expect(await store.getReadyAsset(duplicate!.id, SCHEDULE)).toBeDefined();
    expect(await store.getReadyAsset(c.id, SESSION)).toBeDefined(); expect(readdirSync(store.assetsDirectory)).toHaveLength(2);
    const tooLarge = await store.begin(key(21), TEST);
    await expect(tooLarge.append(new Uint8Array(7))).rejects.toMatchObject({ code: 'protocol_error' });
  });

  it('removes crash-orphaned .part and .mp3 files older than one hour but leaves recent files alone', async () => {
    const { directory, filename, store } = await create(); store.close();
    const oldPart = path.join(store.assetsDirectory, `${randomUUID()}.part`);
    const oldReady = path.join(store.assetsDirectory, `${randomUUID()}.mp3`);
    const freshPart = path.join(store.assetsDirectory, `${randomUUID()}.part`);
    const unrelated = path.join(store.assetsDirectory, 'user-file.txt');
    for (const file of [oldPart, oldReady, freshPart, unrelated]) writeFileSync(file, 'data');
    const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    for (const file of [oldPart, oldReady, unrelated]) utimesSync(file, old, old);
    const reopened = new SqliteSpeechAssetStore(filename); stores.push(reopened);
    expect(readdirSync(reopened.assetsDirectory).sort()).toEqual([path.basename(freshPart), path.basename(unrelated)].sort());
    expect(reopened.assetsDirectory.startsWith(realpathSync(directory))).toBe(true);
  });

  it('rejects symlinked audio and size changes, revoking poisoned metadata without following links', async () => {
    const { directory, store } = await create(); const asset = await publish(store, key(22));
    const ready = (await store.getReadyAsset(asset.id, SESSION))!;
    const external = path.join(directory, 'outside.mp3'); writeFileSync(external, Buffer.from([9, 9, 9]));
    unlinkSync(ready.path); symlinkSync(external, ready.path);
    expect(await store.getReadyAsset(asset.id, SESSION)).toBeUndefined();
    expect(readFileSync(external)).toEqual(Buffer.from([9, 9, 9]));
    const changed = await publish(store, key(23)); const changedReady = (await store.getReadyAsset(changed.id, SESSION))!;
    writeFileSync(changedReady.path, Buffer.from([1]));
    expect(await store.find(key(23), TEST)).toBeUndefined(); expect(await store.getReadyAsset(changed.id, SESSION)).toBeUndefined();
    expect(readdirSync(store.assetsDirectory)).toEqual([]);
  });

  it('does not publish a replaced temporary inode or accept plaintext/path-shaped keys', async () => {
    const { directory, store } = await create();
    await expect(store.begin('private text / voice.mp3', SESSION)).rejects.toMatchObject({ code: 'protocol_error' });
    await expect(store.find('../outside', SESSION)).rejects.toMatchObject({ code: 'protocol_error' });
    await expect(store.begin('0'.repeat(64), SESSION)).rejects.toMatchObject({ code: 'protocol_error' });
    await expect(store.find(`sha256:${'A'.repeat(64)}`, SESSION)).rejects.toMatchObject({ code: 'protocol_error' });
    const writer = await store.begin(key(24), SESSION); await writer.append(Uint8Array.from([1, 2, 3]));
    const temporary = path.join(store.assetsDirectory, readdirSync(store.assetsDirectory)[0]!);
    const external = path.join(directory, 'private.mp3'); writeFileSync(external, Buffer.from([8, 8, 8]));
    unlinkSync(temporary); symlinkSync(external, temporary);
    await expect(writer.complete()).rejects.toMatchObject({ code: 'protocol_error' });
    expect(readFileSync(external)).toEqual(Buffer.from([8, 8, 8])); expect(readdirSync(store.assetsDirectory)).toEqual([]);
  });

  it('rejects an asset root symlink and ignores corrupt manifest paths without deleting outside files', async () => {
    const { directory, filename, store } = await create(); const external = path.join(directory, 'outside.mp3'); writeFileSync(external, 'safe');
    store.close(); const database = new DatabaseSync(filename);
    database.prepare(`INSERT INTO speech_audio_entities(entity_id, cache_key, bytes, created_at, expires_at, last_accessed_at)
      VALUES (?, ?, 4, 0, ?, 0)`).run('../../outside', key(25), Date.now() + 100000);
    database.close(); const reopened = new SqliteSpeechAssetStore(filename); stores.push(reopened);
    expect(await reopened.find(key(25), SESSION)).toBeUndefined(); expect(readFileSync(external).toString()).toBe('safe');
    const linked = path.join(directory, 'linked-assets'); symlinkSync(store.assetsDirectory, linked);
    expect(() => new SqliteSpeechAssetStore(path.join(directory, 'other.sqlite'), { assetsDirectory: linked }))
      .toThrowError(expect.objectContaining({ code: 'protocol_error' }));
  });
});
