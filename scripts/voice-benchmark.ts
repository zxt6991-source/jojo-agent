import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, lstat, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { arch, cpus, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createLocalSpeechSettings, SpeechProviderError } from '@desktop-agent/contracts';
import { createSpeechProvider } from '@desktop-agent/providers';
import { createBufferedRealtimeTtsProvider, createRealtimeTtsProvider, pcm24kFromWav, summarizeVoiceLatency } from '@desktop-agent/speech';
import { LocalTtsCandidateProcess } from '../apps/desktop/src/worker/sherpa-tts-candidate';
import manifest from './local-tts-models.json';
import cosyManifest from './cosyvoice-models.json';
import mlxManifest from './mlx-tts-models.json';
import { runTtsBenchmark, type TtsBenchmarkRun } from './tts-benchmark-runner';
import { synthesizeBenchmarkReference } from './tts-benchmark-reference';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
interface PinnedFile { path: string; bytes: number; sha256?: string; gitBlob?: string }
async function inspectFiles(directory: string, entries: readonly PinnedFile[]) {
  const files = [];
  for (const file of entries) {
    const target = join(directory, file.path), info = await stat(target);
    if (!info.isFile() || info.size !== file.bytes) throw new Error('invalid_model_size');
    const strong = createHash('sha256'), git = createHash('sha1').update(`blob ${info.size}\0`);
    for await (const bytes of createReadStream(target)) { strong.update(bytes); git.update(bytes); }
    const sha256 = strong.digest('hex'), gitBlob = git.digest('hex');
    if (file.sha256 ? sha256 !== file.sha256 : gitBlob !== file.gitBlob) throw new Error('invalid_model_digest');
    files.push({ path: file.path, bytes: info.size, sha256 });
  }
  return { bytes: files.reduce((sum, file) => sum + file.bytes, 0), files };
}

async function syntheticReference(signal: AbortSignal) {
  const directory = join(ROOT, '.local-speech/cosyvoice-evaluation'), target = join(directory, 'reference-say.wav');
  let wav: Uint8Array | undefined;
  try { wav = await readFile(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!wav) {
    const provider = createSpeechProvider(createLocalSpeechSettings()).tts;
    wav = await synthesizeBenchmarkReference(provider, signal);
    await mkdir(directory, { recursive: true, mode: 0o700 }); await writeFile(target, wav, { flag: 'wx', mode: 0o600 });
  }
  const pcm = pcm24kFromWav(wav);
  return { path: target, metadata: { origin: 'synthetic_macos_say_fixed_chinese_prompt', sha256: createHash('sha256').update(wav).digest('hex'), audioMs: pcm.length / 48 } };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter(arg => arg !== '--');
  const { values } = parseArgs({ args, options: {
    provider: { type: 'string', default: 'say' }, iterations: { type: 'string' }, python: { type: 'string' },
    scenario: { type: 'string', default: 'standard' }, 'cancel-after-ms': { type: 'string' },
    'model-dir': { type: 'string' }, 'source-dir': { type: 'string' }, output: { type: 'string', default: 'auto' }, report: { type: 'string' }, help: { type: 'boolean', short: 'h' }
  } });
  if (values.help) { process.stdout.write('Local TTS comparison: --provider say|sherpa-melo|cosyvoice3|mlx-qwen3 --iterations 1..10 (default 3, CosyVoice/MLX 1).\n--scenario cancel-recovery measures short utterances and cancellation/recovery only; --cancel-after-ms 0..10000 (default 50).\n--output auto|native|buffered selects incremental PCM or the full-WAV compatibility adapter.\n--python PATH --model-dir PATH --source-dir PATH override prepared local paths.\n--report PATH creates a new numeric-only JSON file (never overwrites).\nCosyVoice creates/reuses a fixed synthetic say reference; no playback, microphone, download or settings changes.\n'); return; }
  if (!['say', 'sherpa-melo', 'cosyvoice3', 'mlx-qwen3'].includes(values.provider)) throw new Error('invalid_provider');
  if (!['auto', 'native', 'buffered'].includes(values.output)) throw new Error('invalid_output_mode');
  if (!['standard', 'cancel-recovery'].includes(values.scenario)) throw new Error('invalid_benchmark_scenario');
  const cancelProbeDelayMs = Number(values['cancel-after-ms'] ?? '50');
  if (!Number.isSafeInteger(cancelProbeDelayMs) || cancelProbeDelayMs < 0 || cancelProbeDelayMs > 10_000) throw new Error('invalid_cancel_probe_delay');
  const cosy = values.provider === 'cosyvoice3', mlx = values.provider === 'mlx-qwen3', iterations = Number(values.iterations ?? (cosy || mlx ? '1' : '3'));
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10) throw new Error('invalid_iterations');
  if (values.report) {
    const exists = await lstat(resolve(values.report)).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    if (exists) throw new Error('benchmark_report_already_exists');
    const parent = dirname(resolve(values.report));
    if (!(await stat(parent)).isDirectory()) throw new Error('invalid_benchmark_report_directory');
    await access(parent, constants.W_OK);
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const resources = { peakCpuPercent: 0, peakRssBytes: 0, samples: 0 }, children = new Set<number>();
  let sampling = false;
  const onProcess = (child: ChildProcessWithoutNullStreams) => {
    if (!child.pid) return;
    const pid = child.pid; children.add(pid);
    child.once('close', () => children.delete(pid)); child.once('error', () => children.delete(pid));
  };
  const timer = setInterval(() => {
    if (!children.size || sampling) return;
    sampling = true;
    execFile('/bin/ps', ['-o', '%cpu=,rss=', '-p', [...children].join(',')], (error, stdout) => {
      sampling = false; if (error) return;
      const rows = stdout.trim().split('\n').map(row => row.trim().split(/\s+/u).map(Number));
      if (!rows.length || rows.some(row => row.length !== 2 || row.some(value => !Number.isFinite(value)))) return;
      resources.samples++; resources.peakCpuPercent = Math.max(resources.peakCpuPercent, rows.reduce((sum, row) => sum + row[0]!, 0));
      resources.peakRssBytes = Math.max(resources.peakRssBytes, rows.reduce((sum, row) => sum + row[1]! * 1024, 0));
    });
  }, 50);
  const native: Array<{ category: string; firstCallbackMs: number | null; firstNativePcmMs: number | null; callbacks: number; completed: boolean }> = [];
  const completedMeasurements: TtsBenchmarkRun[] = [];
  let pendingAttempt = { category: '', startMs: 0 };
  let candidate: LocalTtsCandidateProcess | undefined, phase = 'unknown';
  let modelVerified = false, sourcesVerified = false;
  const modelDirectory = resolve(values['model-dir'] ?? join(ROOT, mlx ? '.local-speech/models/Qwen3-TTS-0.6B-4bit' : cosy ? '.local-speech/models/CosyVoice3-0.5B' : '.local-speech/models/MeloTTS-zh-en-int8'));
  const sourceDirectory = resolve(values['source-dir'] ?? join(ROOT, '.local-speech/cosyvoice-evaluation/source'));
  try {
    const model = values.provider !== 'say' ? { revision: mlx ? mlxManifest.revision : cosy ? cosyManifest.model.revision : manifest.revision, ...await inspectFiles(modelDirectory, mlx ? mlxManifest.files : cosy ? cosyManifest.model.files : manifest.files) } : null;
    modelVerified = model !== null;
    const sources = cosy ? await Promise.all(cosyManifest.sources.map(async source => ({ name: source.name, revision: source.revision,
      ...await inspectFiles(join(sourceDirectory, source.target.replace(/^source\/?/u, '')), source.files) }))) : null;
    sourcesVerified = sources !== null;
    const reference = cosy ? await syntheticReference(controller.signal) : null;
    if (model) candidate = new LocalTtsCandidateProcess({
      pythonPath: resolve(values.python ?? join(ROOT, mlx ? '.local-speech/venv-mlx-tts/bin/python3' : cosy ? '.local-speech/venv-cosyvoice/bin/python3' : '.local-speech/venv/bin/python3')),
      scriptPath: join(ROOT, mlx ? 'apps/desktop/src/worker/speech-sidecar/mlx_tts.py' : cosy ? 'apps/desktop/src/worker/speech-sidecar/cosyvoice_candidate.py' : 'apps/desktop/src/worker/speech-sidecar/tts_candidate.py'),
      modelDirectory, ...(mlx ? { engine: 'mlx-qwen3', timeoutMs: 180000 } : cosy ? { engine: 'cosyvoice3', sourceDirectory, referenceWav: reference!.path, timeoutMs: 180000 } : {}),
      onProcess,
      onObservation(event) {
        if (event.type === 'started') native.push({ category: pendingAttempt.category, firstCallbackMs: null, firstNativePcmMs: null, callbacks: 0, completed: false });
        else {
          const current = native.at(-1);
          if (current && event.type === 'native_callback') { current.firstCallbackMs ??= event.atMs ?? null; current.callbacks++; }
          if (current && event.type === 'native_pcm') current.firstNativePcmMs ??= performance.now() - pendingAttempt.startMs;
          if (current && event.type === 'completed') current.completed = true;
        }
      }
    });
    const source = candidate ?? createSpeechProvider(createLocalSpeechSettings(), { macos: { spawn: (command, argv, options) => {
      const child = spawn(command, argv, options); onProcess(child as ChildProcessWithoutNullStreams); return child;
    } } }).tts;
    if (values.output === 'native' && !source.synthesizePcm) throw new Error('native_output_unavailable');
    const adapter = values.output === 'buffered' ? createBufferedRealtimeTtsProvider(source) : createRealtimeTtsProvider(source);
    const measured = await runTtsBenchmark(adapter, { iterations, scenario: values.scenario as 'standard' | 'cancel-recovery', cancelProbeDelayMs, signal: controller.signal, onUtteranceStart(event) {
      pendingAttempt = event; process.stderr.write(`TTS benchmark: ${event.category}\n`);
    }, onUtteranceComplete(run) { completedMeasurements.push(run); }, onBeforeCancel() {
      phase = candidate ? (native.at(-1)?.completed === false ? 'native_generating' : 'buffered_or_not_started') : 'say_or_buffered';
    } });
    // Probe only after cold-start and recovery measurements; never warm the first run.
    const runtime = candidate ? await candidate.probe() : null;
    const warmNativePcm = native.slice(1).filter(run => run.completed && !['cancel', 'recovery'].includes(run.category)).map(run => run.firstNativePcmMs!);
    const report = {
      version: 3, benchmarkStatus: 'completed', measuredAt: new Date().toISOString(), device: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
      provider: mlx ? 'mlx-qwen3-4bit' : cosy ? 'cosyvoice3-cpu' : candidate ? 'sherpa-melo-int8' : 'macos-say', capabilities: adapter.capabilities, ...measured,
      benchmarkSettings: { iterations, scenario: values.scenario, outputMode: adapter.capabilities.audioStreaming ? 'native' : 'buffered', inferenceProvider: mlx ? 'metal' : candidate ? 'cpu' : 'system', inferenceThreads: candidate && !mlx ? 2 : null, runtimeProbeTiming: 'after_cancel_recovery' },
      cancellation: { mode: runtime?.cooperativeCancel ? 'cooperative_batch_boundary_with_750ms_termination_fallback' : candidate ? 'terminate_process_and_reload' : 'cancel_say_request', observedPhase: phase, noPostCancelAudio: true },
      sampledChildPeakCpuPercent: resources.samples ? resources.peakCpuPercent : null,
      sampledChildPeakRssBytes: resources.samples ? resources.peakRssBytes : null, resourceSamples: resources.samples, resourceSamplingMs: 50,
      resourceScope: 'direct_child_processes_only_not_os_voice_services', appPackageDeltaBytes: candidate ? null : 0, externalModelBytes: model?.bytes ?? 0,
      model, sources, reference: reference?.metadata ?? null, runtime, processesStarted: candidate?.processesStarted ?? null,
      nativeSentenceCallbacks: candidate ? native : null,
      nativePcmWarmFirstMs: candidate && warmNativePcm.length ? summarizeVoiceLatency(warmNativePcm) : null,
      nativeOutputMode: adapter.capabilities.audioStreaming ? 'incremental_generated_batches_delivered_to_session_consumer' : cosy || mlx ? 'incremental_generated_batches_observed_before_WAV_buffer' : candidate ? 'complete_utterance' : null,
      resampler: cosy || mlx ? 'native_24000_pcm16_quantization' : candidate ? 'numpy_48_tap_windowed_sinc_44100_to_24000_complete_utterance' : null,
      subjectiveChineseMos: null, prosodyContinuity: null, mixedPronunciation: null,
      candidates: cosy || mlx ? [] : [{ provider: 'cosyvoice', status: 'not_measured_by_this_run' }],
      productionTtsChanged: false, acousticReleaseGate: 'pending_physical_device_listening'
    };
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (values.report) await writeFile(resolve(values.report), json, { flag: 'wx', mode: 0o600 });
    process.stdout.write(json);
  } catch (error) {
    const report = { version: 3, benchmarkStatus: 'failed', measuredAt: new Date().toISOString(), provider: values.provider,
      device: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
      failure: { code: error instanceof SpeechProviderError ? error.code : 'preparation_or_report_failure', category: pendingAttempt.category || null },
      verified: { model: modelVerified, sources: sourcesVerified }, completedMeasurements,
      modelRevision: mlx ? mlxManifest.revision : cosy ? cosyManifest.model.revision : values.provider === 'sherpa-melo' ? manifest.revision : null,
      partialNativeMeasurements: native, aggregateMeasurements: null,
      productionTtsChanged: false, acousticReleaseGate: 'not_accepted' };
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (values.report) await writeFile(resolve(values.report), json, { flag: 'wx', mode: 0o600 });
    process.stdout.write(json); process.exitCode = 1;
  } finally {
    clearInterval(timer); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); await candidate?.dispose();
  }
}
void main().catch(error => {
  process.stderr.write(error instanceof Error && error.message === 'benchmark_report_already_exists'
    ? 'Benchmark report already exists; choose a new report path. No synthesis was started.\n'
    : 'Local voice benchmark failed; check the provider, verified local model/runtime and new report path.\n');
  process.exitCode = 1;
});
