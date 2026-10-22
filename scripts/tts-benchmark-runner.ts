import type { RealtimeTtsProvider } from '@desktop-agent/speech';
import { summarizeVoiceLatency } from '@desktop-agent/speech';

/** Fixed synthetic text, never includes user messages or transcripts. */
export const TTS_BENCHMARK_CORPUS = [
  ['short', '我看一下现在的语音链路。'],
  ['sentence', '已经找到播放延迟的主要原因，我会先验证流式播放，再检查回声消除，具体结果放在屏幕上。'],
  ['long', '这次调整会保留现有的录音轮次校验和任务去重，把语音播放与任务执行分开处理。用户打断说话时只停止声音，正在执行的任务按原有规则继续。接下来需要在目标电脑上验证扬声器回声、耳机切换、连续播放和恢复，只有这些检查通过以后，才会开放连续语音和自然插话。'],
  ['date', '今天是二零二六年十月十七日，下午三点二十五分，数值为一百二十三点四五。'],
  ['model', 'Streaming Paraformer、SenseVoice 和 CosyVoice 都需要在 Apple Silicon 上实测。'],
  ['symbols', '变量 speechGeneration 加一，类型是 VoiceSession。'],
  ['path', 'packages/speech/src/voice-session.ts'],
  ['command', 'git status --short，pnpm typecheck。']
] as const;

export interface TtsBenchmarkRun { category: string; cold: boolean; firstPcmMs: number; totalMs: number; audioMs: number; rtf: number }
export interface TtsBenchmarkOptions {
  iterations: number;
  scenario?: 'standard' | 'cancel-recovery';
  cancelProbeDelayMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  waitBeforeCancel?: () => Promise<void>;
  onBeforeCancel?: () => void;
  onUtteranceStart?: (event: { category: string; startMs: number }) => void;
  onUtteranceComplete?: (run: TtsBenchmarkRun) => void;
}

export async function runTtsBenchmark(provider: RealtimeTtsProvider, options: TtsBenchmarkOptions) {
  if (!Number.isInteger(options.iterations) || options.iterations < 1 || options.iterations > 10) throw new Error('invalid_benchmark_iterations');
  const cancelProbeDelayMs = options.cancelProbeDelayMs ?? 50;
  if (!Number.isSafeInteger(cancelProbeDelayMs) || cancelProbeDelayMs < 0 || cancelProbeDelayMs > 10_000) throw new Error('invalid_cancel_probe_delay');
  const corpus = options.scenario === 'cancel-recovery' ? TTS_BENCHMARK_CORPUS.slice(0, 1) : TTS_BENCHMARK_CORPUS;
  const now = options.now ?? (() => performance.now());
  let generation = 0;
  const measure = async (text: string, category: string, cold: boolean): Promise<TtsBenchmarkRun> => {
    const identity = generation++, start = now();
    options.onUtteranceStart?.({ category, startMs: start });
    const session = await provider.open({ sessionId: 'benchmark', generation: identity, speakerId: 'default', speechRate: 0, ...(options.signal ? { signal: options.signal } : {}) });
    let first: number | undefined, frames = 0, previousSequence = 0;
    const consume = (async () => {
      for await (const chunk of session.audio()) {
        if (chunk.sessionId !== 'benchmark' || chunk.generation !== identity || chunk.segmentId !== category
          || chunk.sequence !== ++previousSequence || chunk.sampleRate !== 24000 || chunk.channels !== 1 || chunk.codec !== 'pcm16le'
          || !chunk.pcm.length || chunk.pcm.length % 2) throw new Error('invalid_benchmark_audio');
        first ??= now() - start;
        frames += chunk.pcm.length / 2;
      }
    })();
    // Observe consumption rejection immediately, including append/start failures.
    void consume.catch(() => undefined);
    try {
      await session.append(text, { segmentId: category, endSegment: true });
      await Promise.all([session.finish(), consume]);
      if (options.signal?.aborted || first === undefined || !frames) throw new Error('missing_benchmark_audio');
      const totalMs = now() - start, audioMs = frames / 24;
      const run = { category, cold, firstPcmMs: first, totalMs, audioMs, rtf: totalMs / audioMs };
      options.onUtteranceComplete?.(run);
      return run;
    } finally { await session.cancel(); await consume.catch(() => undefined); }
  };
  const runs: TtsBenchmarkRun[] = [];
  for (let iteration = 0; iteration < options.iterations; iteration++) for (const [category, text] of corpus) {
    runs.push(await measure(text, category, runs.length === 0));
  }
  options.onUtteranceStart?.({ category: 'cancel', startMs: now() });
  const cancellation = await provider.open({ sessionId: 'benchmark-cancel', generation: generation++, speakerId: 'default', speechRate: 0, ...(options.signal ? { signal: options.signal } : {}) });
  let cancelLatencyMs: number;
  try {
    await cancellation.append(TTS_BENCHMARK_CORPUS[2][1], { segmentId: 'cancel', endSegment: true });
    await (options.waitBeforeCancel ?? (() => new Promise<void>(resolve => setTimeout(resolve, cancelProbeDelayMs))))();
    options.onBeforeCancel?.();
    const start = now(); await cancellation.cancel(); cancelLatencyMs = now() - start;
    for await (const chunk of cancellation.audio()) { if (chunk) throw new Error('post_cancel_audio'); }
    if (options.signal?.aborted) throw new Error('benchmark_cancelled');
  } finally { await cancellation.cancel(); }
  const recovery = await measure(TTS_BENCHMARK_CORPUS[0][1], 'recovery', false);
  // Whether cancellation evicts the model is provider-specific. Do not label
  // this request warm just because it follows the initial corpus.
  const postCancelRecovery = { firstPcmMs: recovery.firstPcmMs, totalMs: recovery.totalMs, audioMs: recovery.audioMs, rtf: recovery.rtf };
  const warm = runs.filter(run => !run.cold);
  const rtf = summarizeVoiceLatency(runs.map(run => run.rtf));
  // RTF is a dimensionless ratio; the latency helper's field names carry ms.
  return { coldStartMs: runs[0]!.firstPcmMs, warmFirstPcmMs: warm.length ? summarizeVoiceLatency(warm.map(run => run.firstPcmMs)) : null,
    totalGenerationMs: summarizeVoiceLatency(runs.map(run => run.totalMs)),
    rtf: { samples: rtf.samples, p50: rtf.p50Ms, p95: rtf.p95Ms, mean: rtf.meanMs },
    cancelLatencyMs, cancelProbeDelayMs, postCancelRecovery, runs };
}
