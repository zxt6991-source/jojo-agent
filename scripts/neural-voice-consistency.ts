/** Local, synthetic long-read comparison. No downloads, playback or user settings.
 * PCM equality measures request-order determinism, not cross-text voice identity. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { SpeechProviderError } from '@desktop-agent/contracts';
import { normalizeSpeechTextContent, speechTextSegment } from '@desktop-agent/speech';
import { LocalTtsCandidateProcess } from '../apps/desktop/src/worker/sherpa-tts-candidate';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FIXTURES = {
  chinese: '清晨，我沿着河边的小路慢慢往前走。树叶上的露水还没有干，远处的桥下传来轻轻的水声。今天没有紧急的安排，我想把这一段安静的时间留给自己。'
    + '走到街角的时候，面包店刚刚打开门。店主正在整理柜台，把新烤好的面包放到木架上。我买了一杯热茶，坐在靠窗的位置，看着路上的人慢慢多起来。有人推着自行车，有人牵着孩子，每个人都按照自己的节奏开始新的一天。'
    + '喝完茶以后，我继续向图书馆走去。窗外的阳光落在书页上，给普通的文字添了一点温度。我翻开一本很久没有读完的书，从上次留下的地方接着读。那些原本模糊的细节，随着阅读渐渐清楚起来。'
    + '午后回家的路上，风已经暖和了许多。我记下今天看到的几件小事，也给明天留下一点空白。不必把每一分钟都安排得很满，生活有时候需要一段缓慢而连贯的叙述，让思绪自然地向前流动。',
  mixed: 'Good morning. 今天我们继续阅读项目说明，先了解整体目标，再逐步检查每一个步骤。整篇说明使用同一个声音，遇到英文时保持自然的停顿，然后回到中文继续讲解。'
    + 'The morning light is soft and clear. We open the window, make a cup of tea, and plan the day together. Every small step helps us move forward. '
    + '下面回到中文。阅读长文本时，我们关注相邻段落是否像同一个人在说话，也关注语速和停顿是否自然。即使中间出现英文句子，前后的中文也应该保持稳定的声音。'
    + 'Please save your work before closing the window. You can continue from the same place tomorrow. '
    + '最后，再读一段中文作为结束。记录真实的结果，保留需要改进的地方，然后按照原来的节奏继续。这份说明的目的，是检查从中文到英文、再回到中文时的连续体验。',
};
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
function segments(text: string): string[] {
  const chars = Array.from(normalizeSpeechTextContent(text)), result: string[] = [];
  for (let offset = 0; offset < chars.length;) {
    const part = speechTextSegment(chars, offset, result.length ? 200 : 80);
    result.push(part); offset += Array.from(part).length;
  }
  return result;
}
function wav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
interface Row {
  profile: string; category: string; speaker: string; textSha256: string; textChars: number;
  status: 'completed' | 'cancelled' | 'failed'; pcmSha256: string | null; audioMs: number;
  firstPcmMs: number | null; totalMs: number; error: string | null;
}
interface Comparison { profile: string; category: string; samePcmAsFirst: boolean }
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'baseline-script': { type: 'string' }, 'output-dir': { type: 'string' } } });
  const baseline = values['baseline-script'] ?? '', output = values['output-dir'] ?? '';
  if (!baseline || !output || !isAbsolute(baseline) || !isAbsolute(output)) throw new Error('absolute_paths_required');
  const current = join(ROOT, 'apps/desktop/src/worker/speech-sidecar/mlx_tts.py');
  const sources = { baseline: digest(await readFile(baseline)), current: digest(await readFile(current)) };
  // Reserve a new directory before launching a model. Never overwrite samples.
  await mkdir(output, { mode: 0o700 });
  const report = {
    measuredAt: new Date().toISOString(), status: 'running', physicalOutputPlayed: false,
    listeningQualityAssessed: false, scope: 'request_order_determinism_and_long_read_samples',
    runtime: 'mlx-audio-0.5.9', modelRevision: '08c72cad5e2fd0f41730c8bd1f28149585e46361',
    modelHashesVerified: false, sourceSha256: sources,
    segmentLimits: { first: 80, subsequent: 200 },
    fixtures: Object.entries(FIXTURES).map(([name, text]) => ({ name, textSha256: digest(text), chars: Array.from(text).length, segments: segments(text).map(part => Array.from(part).length) })),
    rows: [] as Row[], comparisons: [] as Comparison[], processes: [] as Array<{ profile: string; count: number }>,
  };
  const save = () => writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  const stop = new AbortController();
  const abort = () => stop.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  await save();
  try {
    for (const [profile, scriptPath] of [['baseline', baseline], ['current', current]] as const) {
      let processCount = 0;
      const create = () => new LocalTtsCandidateProcess({
        pythonPath: join(ROOT, '.local-speech/venv-mlx-tts/bin/python3'), scriptPath,
        modelDirectory: join(ROOT, '.local-speech/models/Qwen3-TTS-0.6B-4bit'), engine: 'mlx-qwen3', timeoutMs: 180000,
      });
      let candidate = create();
      async function render(category: string, text: string, speaker = 'Serena', cancel = false): Promise<Buffer> {
        const controller = new AbortController(), signal = AbortSignal.any([stop.signal, controller.signal]);
        const chunks: Uint8Array[] = [], started = performance.now();
        let first: number | null = null, completed = false;
        const row: Row = { profile, category, speaker, textSha256: digest(text), textChars: Array.from(text).length,
          status: 'failed', pcmSha256: null, audioMs: 0, firstPcmMs: null, totalMs: 0, error: null };
        process.stdout.write(`${profile}: ${category}\n`);
        try {
          for await (const event of candidate.synthesizePcm!({ requestId: `${profile}-${category}`, text, speakerId: speaker, speechRate: 0, signal })) {
            if (event.type === 'pcm') {
              first ??= performance.now() - started; chunks.push(event.bytes);
              if (cancel) controller.abort();
            } else if (event.type === 'completed') completed = true;
          }
          if (!completed || cancel) throw new Error('unexpected_completion');
          const pcm = Buffer.concat(chunks);
          row.status = 'completed'; row.pcmSha256 = digest(pcm); row.audioMs = pcm.length / 48;
          await writeFile(join(output, `${profile}-${category}.wav`), wav(pcm), { flag: 'wx', mode: 0o600 });
          return pcm;
        } catch (error) {
          row.error = error instanceof SpeechProviderError ? error.code : 'diagnostic_failed';
          if (cancel && controller.signal.aborted && !stop.signal.aborted && row.error === 'cancelled') {
            row.status = 'cancelled'; return Buffer.alloc(0);
          }
          throw error;
        } finally {
          row.firstPcmMs = first; row.totalMs = performance.now() - started;
          report.rows.push(row); await save();
        }
      }
      try {
        await candidate.warmup(stop.signal);
        const anchors: Array<{ name: string; text: string; hash: string }> = [];
        for (const [name, text] of Object.entries(FIXTURES)) {
          const parts = segments(text), audio: Buffer[] = [];
          for (const [index, part] of parts.entries()) {
            const pcm = await render(`${name}-${index + 1}`, part);
            audio.push(pcm);
            if (index === 0) anchors.push({ name, text: part, hash: digest(pcm) });
          }
          await writeFile(join(output, `${profile}-${name}-joined.wav`), wav(Buffer.concat(audio)), { flag: 'wx', mode: 0o600 });
        }
        await render('other-speaker', '这是另一种声音的独立试听，接下来恢复原来的朗读。', 'Vivian');
        const compare = async (stage: string, speaker = 'Serena') => {
          for (const anchor of anchors) {
            const category = `${anchor.name}-${stage}`, pcm = await render(category, anchor.text, speaker);
            report.comparisons.push({ profile, category, samePcmAsFirst: digest(pcm) === anchor.hash });
            await save();
          }
        };
        await compare('after-other-voice');
        await compare('default-alias', 'default');
        await render('cancel-after-pcm', segments(FIXTURES.chinese)[1]!, 'Serena', true);
        await compare('after-cancel');
        processCount += candidate.processesStarted;
        await candidate.dispose(); candidate = create();
        await compare('after-restart');
      } finally {
        processCount += candidate.processesStarted;
        await candidate.dispose(); report.processes.push({ profile, count: processCount }); await save();
      }
    }
    if (report.comparisons.some(row => row.profile === 'current' && !row.samePcmAsFirst)) throw new Error('request_order_determinism_failed');
    report.status = 'completed'; await save();
  } catch (error) {
    report.status = 'failed'; await save(); throw error;
  } finally {
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
  }
}
void main().catch(error => {
  process.stderr.write(`Voice consistency diagnostic failed: ${error instanceof SpeechProviderError ? error.code : error instanceof Error ? error.message : 'unknown'}.\n`);
  process.exitCode = 1;
});
