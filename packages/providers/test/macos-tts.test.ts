import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

import { type TtsEvent } from '@desktop-agent/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMacosTtsProvider, listMacosTtsVoices, type MacosTtsOptions } from '../src/speech/macos-tts.js';

const requestId = 'f560f9e2-e992-4bc8-b017-5c2c4a0344f1';
const voiceList = 'Samantha            en_US    # Hello\nBad News            en_US    # Hello\nTingting            zh_CN    # 你好\nEddy (中文（中国大陆）)   zh_CN    # 你好\n';
const roots: string[] = [];
const input = (signal = new AbortController().signal) => ({ requestId, text: '你好，Jojo。', speakerId: 'default', speechRate: 0, signal });

function wav(): Buffer {
  const bytes = Buffer.alloc(44 + 480);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(480, 40);
  return bytes;
}
async function root(): Promise<string> { const path = await mkdtemp(join(tmpdir(), 'jojo-tts-test-')); roots.push(path); return path; }
async function collect(stream: AsyncIterable<TtsEvent>): Promise<TtsEvent[]> { const result: TtsEvent[] = []; for await (const event of stream) result.push(event); return result; }

interface FakeChild extends EventEmitter { stdin: PassThrough; stdout: PassThrough; kill: ReturnType<typeof vi.fn> }
type OnProcess = (child: FakeChild, args: readonly string[], stdin: string) => void | Promise<void>;
function transport(onSynthesis?: OnProcess, listing = voiceList): { spawn: NonNullable<MacosTtsOptions['spawn']>; processes: FakeChild[] } {
  const processes: FakeChild[] = [];
  const spawn = vi.fn((_command: string, args: readonly string[], _options: SpawnOptions) => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill: vi.fn() });
    processes.push(child);
    child.kill.mockImplementation(() => { queueMicrotask(() => child.emit('close', null)); return true; });
    let stdin = '';
    child.stdin.on('data', data => { stdin += data.toString(); });
    child.stdin.on('finish', () => {
      void (async () => {
        if (args.length === 2 && args[1] === '?') { child.stdout.write(listing); child.emit('close', 0); }
        else if (onSynthesis) await onSynthesis(child, args, stdin);
        else { await writeFile(args[args.indexOf('-o') + 1]!, wav()); child.emit('close', 0); }
      })().catch(error => child.emit('error', error));
    });
    return child as unknown as ChildProcess;
  });
  return { spawn, processes };
}
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('macOS local TTS', () => {
  it('synthesizes to a private PCM WAV file, passes text through stdin, and never invokes a shell or audio output', async () => {
    const temporaryDirectory = await root();
    const calls: { args: readonly string[]; text: string; mode: number; fileMode: number }[] = [];
    const { spawn } = transport(async (child, args, text) => {
      const path = args[args.indexOf('-o') + 1]!;
      calls.push({ args, text, mode: (await stat(dirname(path))).mode & 0o777, fileMode: (await stat(path)).mode & 0o777 });
      await writeFile(path, wav()); child.emit('close', 0);
    });
    const text = '你好；$(touch /tmp/should-not-exist) `ignored` --voice Bad News';
    const events = await collect(createMacosTtsProvider({ platform: 'darwin', spawn, temporaryDirectory }).synthesize({ ...input(), text }));
    expect(events).toEqual([{ type: 'audio', requestId, bytes: wav(), format: 'wav', sampleRate: 24000 }, { type: 'completed', requestId }]);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn).toHaveBeenNthCalledWith(2, '/usr/bin/say', expect.arrayContaining(['-v', 'Tingting', '-r', '180', '-o', '--file-format=WAVE', '--data-format=LEI16@24000', '--channels=1', '-f', '-']), { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    expect(calls[0]).toMatchObject({ text, mode: 0o700, fileMode: 0o600 });
    expect(calls[0]!.args.join(' ')).not.toContain(text);
    expect(await readdir(temporaryDirectory)).toEqual([]);
  });

  it('discovers localized names and explicit voices without emitting audio', async () => {
    const { spawn } = transport();
    expect(await listMacosTtsVoices({ platform: 'darwin', spawn })).toEqual([
      { name: 'Samantha', locale: 'en_US' }, { name: 'Bad News', locale: 'en_US' },
      { name: 'Tingting', locale: 'zh_CN' }, { name: 'Eddy (中文（中国大陆）)', locale: 'zh_CN' }
    ]);
    await collect(createMacosTtsProvider({ platform: 'darwin', spawn }).synthesize({ ...input(), speakerId: 'Bad News', speechRate: 100 }));
    expect(spawn).toHaveBeenLastCalledWith('/usr/bin/say', expect.arrayContaining(['-v', 'Bad News', '-r', '360']), expect.any(Object));
  });

  it('selects another installed Chinese voice when Tingting is missing, and maps the slowest rate', async () => {
    const { spawn } = transport(undefined, 'Meijia          zh_TW    # 你好\n');
    await collect(createMacosTtsProvider({ platform: 'darwin', spawn }).synthesize({ ...input(), speechRate: -50 }));
    expect(spawn).toHaveBeenLastCalledWith('/usr/bin/say', expect.arrayContaining(['-v', 'Meijia', '-r', '90']), expect.any(Object));
  });

  it.each(['default', 'not-installed', '--voice Unknown'])('does not invoke synthesis for an unavailable voice %s', async speakerId => {
    const { spawn } = transport(undefined, 'Samantha       en_US    # Hello\n');
    await expect(collect(createMacosTtsProvider({ platform: 'darwin', spawn }).synthesize({ ...input(), speakerId }))).rejects.toMatchObject({ code: 'speaker_unavailable', requestId });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('rejects preflight failures before spawning a process', async () => {
    const { spawn } = transport();
    const adapter = createMacosTtsProvider({ platform: 'darwin', spawn });
    await expect(collect(createMacosTtsProvider({ platform: 'linux', spawn }).synthesize(input()))).rejects.toMatchObject({ code: 'local_unavailable' });
    await expect(collect(adapter.synthesize(input(AbortSignal.abort())))).rejects.toMatchObject({ code: 'cancelled' });
    await expect(collect(adapter.synthesize({ ...input(), text: '' }))).rejects.toMatchObject({ code: 'empty_result' });
    await expect(collect(adapter.synthesize({ ...input(), text: 'a'.repeat(601) }))).rejects.toMatchObject({ code: 'protocol_error' });
    await expect(collect(adapter.synthesize({ ...input(), requestId: 'not-a-uuid' }))).rejects.toMatchObject({ code: 'protocol_error' });
    await expect(collect(adapter.synthesize({ ...input(), speechRate: 101 }))).rejects.toMatchObject({ code: 'protocol_error' });
    await expect(collect(adapter.synthesize({ ...input(), speakerId: 'a\0b' }))).rejects.toMatchObject({ code: 'speaker_unavailable' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(['empty', 'garbage', 'truncated', 'wrong-rate', 'wrong-channels', 'oversized'] as const)('rejects %s output before yielding audio and cleans up', async variant => {
    const temporaryDirectory = await root();
    const { spawn } = transport(async (child, args) => {
      let bytes = wav();
      if (variant === 'empty') bytes = Buffer.alloc(0);
      if (variant === 'garbage') bytes.fill(0);
      if (variant === 'truncated') bytes = bytes.subarray(0, bytes.length - 1);
      if (variant === 'wrong-rate') bytes.writeUInt32LE(22050, 24);
      if (variant === 'wrong-channels') bytes.writeUInt16LE(2, 22);
      if (variant === 'oversized') bytes = Buffer.alloc(1025);
      await writeFile(args[args.indexOf('-o') + 1]!, bytes); child.emit('close', 0);
    });
    const events: TtsEvent[] = [];
    const run = async () => { for await (const event of createMacosTtsProvider({ platform: 'darwin', spawn, temporaryDirectory, maxAudioBytes: 1024 }).synthesize(input())) events.push(event); };
    await expect(run()).rejects.toMatchObject({ code: 'invalid_audio' });
    expect(events).toEqual([]); expect(await readdir(temporaryDirectory)).toEqual([]);
  });

  it('kills an oversized synthesis while the process is still running', async () => {
    const temporaryDirectory = await root();
    const { spawn, processes } = transport(async (_child, args) => { await writeFile(args[args.indexOf('-o') + 1]!, Buffer.alloc(1025)); });
    await expect(collect(createMacosTtsProvider({ platform: 'darwin', spawn, temporaryDirectory, maxAudioBytes: 1024 }).synthesize(input()))).rejects.toMatchObject({ code: 'invalid_audio' });
    expect(processes[1]!.kill).toHaveBeenCalledWith('SIGKILL');
    expect(await readdir(temporaryDirectory)).toEqual([]);
  });

  it('cancels and kills a running process without exposing stderr, raw errors, or the transcript', async () => {
    const temporaryDirectory = await root();
    const controller = new AbortController();
    const { spawn, processes } = transport(child => { child.emit('error', new Error('secret user transcript')); });
    const failed = collect(createMacosTtsProvider({ platform: 'darwin', spawn, temporaryDirectory }).synthesize(input()));
    await expect(failed).rejects.toMatchObject({ code: 'local_unavailable', message: 'The macOS speech command could not start.' });
    expect(await readdir(temporaryDirectory)).toEqual([]);
    const pending = transport(() => { controller.abort(); });
    await expect(collect(createMacosTtsProvider({ platform: 'darwin', spawn: pending.spawn, temporaryDirectory }).synthesize(input(controller.signal)))).rejects.toMatchObject({ code: 'cancelled' });
    expect(pending.processes[1]!.kill).toHaveBeenCalledWith('SIGKILL');
    expect(processes).toHaveLength(2);
    expect(await readdir(temporaryDirectory)).toEqual([]);
  });

  it('enforces a deadline including voice discovery and handles a process that never closes', async () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill: vi.fn(() => true) });
    const spawn = vi.fn(() => child as unknown as ChildProcess);
    vi.useFakeTimers();
    const run = collect(createMacosTtsProvider({ platform: 'darwin', spawn, timeoutMs: 100 }).synthesize(input()));
    const rejection = expect(run).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(351); await rejection;
    expect(child.kill).toHaveBeenCalledWith('SIGKILL'); expect(vi.getTimerCount()).toBe(0);
  });

  it('kills a failing synthesis and ignores its original process diagnostics', async () => {
    const temporaryDirectory = await root();
    const { spawn, processes } = transport(child => { child.emit('error', new Error('private text and process path')); });
    await expect(collect(createMacosTtsProvider({ platform: 'darwin', spawn, temporaryDirectory }).synthesize(input()))).rejects.toMatchObject({
      code: 'local_unavailable', message: 'The macOS speech command could not start.', requestId
    });
    expect(processes[1]!.kill).toHaveBeenCalledWith('SIGKILL');
    expect(await readdir(temporaryDirectory)).toEqual([]);
    const failedSpawn = vi.fn(() => { throw new Error('private text in raw command'); });
    await expect(listMacosTtsVoices({ platform: 'darwin', spawn: failedSpawn })).rejects.toMatchObject({ code: 'local_unavailable', message: 'The macOS speech command is unavailable.' });
  });

  it('caps voice discovery stdout and stops the process', async () => {
    const { spawn, processes } = transport(undefined, 'x'.repeat(256 * 1024 + 1));
    await expect(listMacosTtsVoices({ platform: 'darwin', spawn })).rejects.toMatchObject({ code: 'protocol_error' });
    expect(processes[0]!.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('bounds voice discovery and removes its timers after cancellation', async () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill: vi.fn(() => true) });
    const spawn = vi.fn(() => child as unknown as ChildProcess);
    const controller = new AbortController();
    vi.useFakeTimers();
    const pending = listMacosTtsVoices({ platform: 'darwin', spawn }, controller.signal);
    const rejection = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    controller.abort(); await vi.advanceTimersByTimeAsync(251); await rejection;
    expect(child.kill).toHaveBeenCalledWith('SIGKILL'); expect(vi.getTimerCount()).toBe(0);
  });

  it('does not complete after a consumer cancels between audio and completed', async () => {
    const temporaryDirectory = await root();
    const { spawn } = transport();
    const controller = new AbortController();
    const iterator = createMacosTtsProvider({ platform: 'darwin', spawn, temporaryDirectory }).synthesize(input(controller.signal))[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe('audio');
    expect(await readdir(temporaryDirectory)).toEqual([]);
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ code: 'cancelled' });
    expect(await readdir(temporaryDirectory)).toEqual([]);
  });
});
