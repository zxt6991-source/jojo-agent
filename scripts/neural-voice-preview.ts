/** Fixed, synthetic listening fixtures. Explicit invocation only; never plays audio. */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { createMacosTtsProvider } from '@desktop-agent/providers';
import { pcm24kFromWav } from '@desktop-agent/speech';
import { LocalTtsCandidateProcess } from '../apps/desktop/src/worker/sherpa-tts-candidate';

const root = fileURLToPath(new URL('../', import.meta.url));
const text = '嗯，这个周末可以慢一点。早上出去走走，找家喜欢的小店喝杯咖啡。要是下雨，就在家看看书，也挺好的。';
async function main() {
  const output = resolve(process.argv[2] ?? join(root, '.local-speech/voice-previews/natural-v1'));
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  // New directory only: a prior listening fixture is never silently replaced.
  await mkdir(output, { mode: 0o700 });
  const provider = new LocalTtsCandidateProcess({ engine: 'mlx-qwen3', pythonPath: join(root, '.local-speech/venv-mlx-tts/bin/python3'),
    scriptPath: join(root, 'apps/desktop/src/worker/speech-sidecar/mlx_tts.py'), modelDirectory: join(root, '.local-speech/models/Qwen3-TTS-0.6B-4bit'), timeoutMs: 180000 });
  const controller = new AbortController(), stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const records = [];
  try {
    for (const speakerId of ['Tingting', 'Serena', 'Vivian', 'Uncle_Fu']) {
      const selected = speakerId === 'Tingting' ? createMacosTtsProvider() : provider;
      const requestId = crypto.randomUUID(), started = performance.now();
      let wav: Uint8Array | undefined, completed = false;
      for await (const event of selected.synthesize({ requestId, text, speakerId, speechRate: 0, signal: controller.signal })) {
        if (event.requestId !== requestId || completed) throw new Error('invalid_preview_protocol');
        if (event.type === 'audio') { if (wav) throw new Error('invalid_preview_audio'); wav = event.bytes; }
        else completed = true;
      }
      if (!completed || !wav || controller.signal.aborted) throw new Error('incomplete_preview');
      const audioMs = pcm24kFromWav(wav).length / 48;
      const file = `${speakerId}.wav`; await writeFile(join(output, file), wav, { flag: 'wx', mode: 0o600 });
      records.push({ speakerId, file, audioMs, synthesisMs: performance.now() - started, sha256: createHash('sha256').update(wav).digest('hex') });
      process.stdout.write(`Saved ${file}\n`);
    }
    await writeFile(join(output, 'listening-fixtures.json'), `${JSON.stringify({ text, origin: 'fixed_synthetic_text_no_voice_cloning', records }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } finally { controller.abort(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); await provider.dispose(); }
}
void main().catch(() => { process.stderr.write('Listening fixture generation failed; existing files were preserved.\n'); process.exitCode = 1; });
