import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { SpeechSettingsSchema } from '@desktop-agent/contracts';
import { createBundledSpeechInput } from './bundled-speech-input';

it('materializes the bundled Python sources only on explicit recognition and reports missing local models', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-bundled-speech-'));
  const provider = createBundledSpeechInput(directory, SpeechSettingsSchema.parse({ streamingInput: { enabled: true } }));
  try {
    expect(await readdir(directory)).toEqual([]);
    const consume = async () => {
      for await (const event of provider.recognize({ requestId: crypto.randomUUID(),
        format: { codec: 'pcm16le', channels: 1, sampleRate: 16000 }, signal: new AbortController().signal,
        audio: (async function* () { yield new Uint8Array(6400); })() })) void event;
    };
    await expect(consume()).rejects.toMatchObject({ code: 'local_unavailable' });
    const root = path.join(directory, 'runtime', 'speech-sidecar');
    const versions = await readdir(root); expect(versions).toHaveLength(1);
    expect(await readdir(path.join(root, versions[0]!))).toEqual(['main.py', 'protocol.py', 'smart_turn.py', 'streaming_asr.py', 'vad.py']);
    expect(await readFile(path.join(root, versions[0]!, 'main.py'), 'utf8')).toContain('def main(');
  } finally { await provider.dispose(); await rm(directory, { recursive: true, force: true }); }
});
