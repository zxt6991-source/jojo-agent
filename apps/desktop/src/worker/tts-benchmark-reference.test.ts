import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import type { SpeechTtsProvider, TtsEvent } from '@desktop-agent/contracts';
import { createMacosTtsProvider } from '@desktop-agent/providers';
import { synthesizeBenchmarkReference, SYNTHETIC_REFERENCE_TEXT } from '../../../../scripts/tts-benchmark-reference';

function wav() {
  const bytes = Buffer.alloc(48); bytes.write('RIFF'); bytes.writeUInt32LE(40, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(4, 40); return bytes;
}
it('creates the reference through real macOS Provider validation using UUID attempts and private temp cleanup', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'jojo-reference-')), spoken: string[] = [];
  const provider = createMacosTtsProvider({ platform: 'darwin', temporaryDirectory, spawn(_command, args) {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill: () => true });
    let text = '';
    child.stdin.on('data', bytes => { text += bytes.toString(); });
    child.stdin.on('finish', () => {
      void (async () => {
        if (args[1] === '?') child.stdout.write('Tingting  zh_CN  # 你好\n');
        else { spoken.push(text); await writeFile(args[args.indexOf('-o') + 1]!, wav()); }
        child.emit('close', 0);
      })().catch(error => child.emit('error', error));
    });
    return child as unknown as ChildProcess;
  } });
  try {
    expect(await synthesizeBenchmarkReference(provider, new AbortController().signal)).toEqual(wav());
    expect(spoken).toEqual([SYNTHETIC_REFERENCE_TEXT]); expect(await readdir(temporaryDirectory)).toEqual([]);
  } finally { await rm(temporaryDirectory, { recursive: true, force: true }); }
});

it.each(['incomplete', 'stale', 'corrupt'] as const)('does not cache a %s reference result as a success', async variant => {
  const provider: SpeechTtsProvider = { async *synthesize(input): AsyncIterable<TtsEvent> {
    yield { type: 'audio', requestId: variant === 'stale' ? 'stale' : input.requestId, bytes: variant === 'corrupt' ? new Uint8Array(48) : wav(), format: 'wav', sampleRate: 24000 };
    if (variant !== 'incomplete') yield { type: 'completed', requestId: input.requestId };
  } };
  await expect(synthesizeBenchmarkReference(provider, new AbortController().signal)).rejects.toMatchObject({ code: variant === 'corrupt' ? 'invalid_audio' : 'protocol_error' });
});

it('does not start reference synthesis after cancellation', async () => {
  const provider: SpeechTtsProvider = { synthesize() { throw new Error('should not start'); } };
  await expect(synthesizeBenchmarkReference(provider, AbortSignal.abort())).rejects.toMatchObject({ code: 'cancelled' });
});
