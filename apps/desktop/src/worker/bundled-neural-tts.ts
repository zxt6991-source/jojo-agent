import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SpeechProviderError, type SpeechSettings, type SpeechTtsProvider, type SpeechTtsInput } from '@desktop-agent/contracts';
import main from './speech-sidecar/mlx_tts.py?raw';
import protocol from './speech-sidecar/protocol.py?raw';
import { LocalTtsCandidateProcess, type SherpaTtsCandidateOptions } from './sherpa-tts-candidate';

export interface DesktopNeuralTts extends SpeechTtsProvider { dispose(): Promise<void> }
/** Shared by ordinary replies, explicit reading, presets and reminders. A model
 * loads only on explicit voice use, then stays warm until invalidation. */
export function createBundledNeuralTts(dataDirectory: string, settings: SpeechSettings, options: {
  createProcess?: (options: SherpaTtsCandidateOptions) => DesktopNeuralTts;
} = {}): DesktopNeuralTts {
  const local = settings.provider.tts.local;
  if (!local || !path.isAbsolute(local.pythonPath) || !path.isAbsolute(local.modelDirectory)) {
    throw new SpeechProviderError('local_unavailable', '请填写本机自然声音的运行环境与模型路径。');
  }
  const sources = { 'mlx_tts.py': main, 'protocol.py': protocol };
  const version = createHash('sha256').update(JSON.stringify(sources)).digest('hex').slice(0, 24);
  const directory = path.join(dataDirectory, 'runtime', 'neural-tts', version);
  const provider = (options.createProcess ?? (options => new LocalTtsCandidateProcess(options)))({ ...local, engine: 'mlx-qwen3', scriptPath: path.join(directory, 'mlx_tts.py'), timeoutMs: 180_000 });
  let preparing: Promise<void> | undefined;
  let tail = Promise.resolve();
  let warming: Promise<void> | undefined;
  let queued = 0, disposed = false;
  const prepare = () => preparing ??= (async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const [name, source] of Object.entries(sources)) await writeFile(path.join(directory, name), source, { mode: 0o600 });
  })().catch(() => { preparing = undefined; throw new SpeechProviderError('local_unavailable', '本机自然声音暂时无法准备，请检查运行环境与模型。'); });
  async function* serial<T>(signal: AbortSignal, run: () => AsyncIterable<T>): AsyncIterable<T> {
    if (disposed || signal.aborted) throw new SpeechProviderError('cancelled', '语音合成已停止。');
    if (queued >= 8) throw new SpeechProviderError('rate_limited', '正在合成其他语音，请稍后再试。');
    queued++;
    const previous = tail;
    let release!: () => void;
    const slot = new Promise<void>(resolve => { release = resolve; });
    tail = previous.then(() => slot);
    let abort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => { abort = () => reject(new SpeechProviderError('cancelled', '语音合成已停止。')); });
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (signal.aborted) abort();
      await Promise.race([previous, aborted]);
      if (disposed || signal.aborted) throw new SpeechProviderError('cancelled', '语音合成已停止。');
      await Promise.race([prepare(), aborted]);
      if (disposed || signal.aborted) throw new SpeechProviderError('cancelled', '语音合成已停止。');
      yield* run();
    } finally { queued--; signal.removeEventListener('abort', abort); release(); }
  }
  return {
    synthesize(input) { return serial(input.signal, () => provider.synthesize(input)); },
    ...(provider.synthesizePcm ? {
      synthesizePcm(input: SpeechTtsInput) { return serial(input.signal, () => provider.synthesizePcm!(input)); }
    } : {}),
    ...(provider.warmup ? {
      async warmup(signal: AbortSignal) {
        if (disposed || signal.aborted) throw new SpeechProviderError('cancelled', '语音合成已停止。');
        return warming ??= (async () => {
          for await (const result of serial(signal, async function* () { yield await provider.warmup!(signal); })) { void result; }
        })().finally(() => { warming = undefined; });
      }
    } : {}),
    async dispose() { disposed = true; await provider.dispose(); }
  };
}
