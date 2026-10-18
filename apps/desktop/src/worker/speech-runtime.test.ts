import { SpeechProviderError, SpeechSettingsSchema, createLocalSpeechSettings, type AudioAsset, type AudioAssetWriter, type SpeechAssetStore, type SpeechProvider } from '@desktop-agent/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DesktopSpeechRuntime } from './speech-runtime.js';

const owner = { kind: 'session', id: 'speech-runtime-test' } as const;
const asset: AudioAsset = { id: '8788b2e9-f74a-43ec-ac07-3b715954ee89', owner, format: 'wav', sampleRate: 24000, bytes: 2, createdAt: 100, expiresAt: 1000 };
const settings = (enabled = true) => SpeechSettingsSchema.parse({ enabled });
const input = () => ({ text: '你好', owner, signal: new AbortController().signal });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

function assetsHarness() {
  const writer: AudioAssetWriter = { append: vi.fn(async () => undefined), complete: vi.fn(async () => asset), abort: vi.fn(async () => undefined) };
  const assets: SpeechAssetStore & { close(): void } = {
    find: vi.fn(async () => undefined), begin: vi.fn(async () => writer), release: vi.fn(async () => undefined), releaseOwner: vi.fn(async () => undefined), clear: vi.fn(async () => undefined), close: vi.fn()
  };
  return { assets, writer };
}

function idleProvider(): SpeechProvider {
  return {
    asr: { recognize: vi.fn(async function* (request): ReturnType<SpeechProvider['asr']['recognize']> { yield { type: 'ready', requestId: request.requestId }; }) },
    tts: { synthesize: vi.fn(async function* (request): ReturnType<SpeechProvider['tts']['synthesize']> {
      yield { type: 'audio', requestId: request.requestId, bytes: Uint8Array.of(1, 2), format: 'wav', sampleRate: 24000 };
      yield { type: 'completed', requestId: request.requestId };
    }) }
  };
}

function controlledProvider() {
  const entered = deferred<void>(); let signal: AbortSignal | undefined;
  const provider = idleProvider();
  provider.tts.synthesize = vi.fn(async function* (request): ReturnType<SpeechProvider['tts']['synthesize']> {
    signal = request.signal; entered.resolve();
    await new Promise<void>((_resolve, reject) => {
      const cancelled = () => { request.signal.removeEventListener('abort', cancelled); reject(new SpeechProviderError('cancelled', 'Offline provider cancelled.')); };
      request.signal.addEventListener('abort', cancelled, { once: true }); if (request.signal.aborted) cancelled();
    });
    yield { type: 'completed', requestId: request.requestId };
  });
  return { provider, entered, get signal() { return signal; } };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('worker-owned local speech runtime', () => {
  it('accepts enabled neural settings without probing the runtime until speech is requested', async () => {
    const { assets, writer } = assetsHarness();
    const createNeuralTts = vi.fn(() => { throw new SpeechProviderError('local_unavailable', 'Local voice is not installed.'); });
    const runtime = new DesktopSpeechRuntime('/unused', { assets, createNeuralTts });
    try {
      const configured = SpeechSettingsSchema.parse({ enabled: true, provider: { tts: { id: 'mlx-qwen3', local: { pythonPath: 'python3', modelDirectory: '' } } } });
      await expect(runtime.configure(configured)).resolves.toBeUndefined();
      expect(createNeuralTts).not.toHaveBeenCalled();
      expect(runtime.validationStatus()).toMatchObject({ asr: false, tts: false });
      await expect(runtime.service!.synthesize(input())).rejects.toMatchObject({ code: 'local_unavailable' });
      expect(createNeuralTts).toHaveBeenCalledOnce(); expect(writer.abort).toHaveBeenCalledOnce();
    } finally { runtime.close(); }
  });
  it('shares the offline neural model across saved voice presets and disposes it when the model changes', async () => {
    const { assets } = assetsHarness();
    const neural = { ...idleProvider().tts, dispose: vi.fn(async () => undefined) };
    const createNeuralTts = vi.fn(() => neural);
    const runtime = new DesktopSpeechRuntime('/unused', { assets, createNeuralTts });
    const configured = SpeechSettingsSchema.parse({ provider: { tts: { id: 'mlx-qwen3', local: { pythonPath: '/local/python3', modelDirectory: '/local/model' } } }, voicePresets: [{ id: 'other', name: '另一个声音', speakerId: 'Vivian', speechRate: 0 }] });
    await runtime.configure(configured); expect(createNeuralTts).not.toHaveBeenCalled();
    await runtime.serviceForValidation!.synthesize(input());
    await runtime.serviceForPresetValidation('other')!.synthesize(input());
    expect(createNeuralTts).toHaveBeenCalledOnce();
    expect(neural.synthesize).toHaveBeenNthCalledWith(1, expect.objectContaining({ speakerId: 'default' }));
    expect(neural.synthesize).toHaveBeenNthCalledWith(2, expect.objectContaining({ speakerId: 'Vivian' }));
    await runtime.configure({ ...configured, provider: { ...configured.provider, tts: { ...configured.provider.tts, local: { ...configured.provider.tts.local!, modelDirectory: '/new/model' } } } });
    expect(neural.dispose).toHaveBeenCalledOnce(); runtime.close();
  });
  it('selects and reuses a lazy streaming input provider only when configured, and revokes validation on model changes', async () => {
    const { assets } = assetsHarness(); const fallback = idleProvider();
    const streaming = { recognize: vi.fn(async function* (request: Parameters<SpeechProvider['asr']['recognize']>[0]) {
      yield { type: 'ready' as const, requestId: request.requestId };
      for await (const chunk of request.audio) { void chunk; }
      yield { type: 'final' as const, requestId: request.requestId, text: '常驻转写' };
    }), dispose: vi.fn(async () => undefined) };
    const createStreamingAsr = vi.fn(() => streaming);
    const runtime = new DesktopSpeechRuntime('/unused', { assets, createProvider: () => ({ ...fallback }), createStreamingAsr });
    const configured = SpeechSettingsSchema.parse({ streamingInput: { enabled: true, vadModel: '/vad.onnx', paraformerDirectory: '/paraformer' } });
    await runtime.configure(configured); expect(createStreamingAsr).not.toHaveBeenCalled();
    const service = runtime.serviceForValidation!;
    expect(createStreamingAsr).toHaveBeenCalledOnce(); expect(streaming.recognize).not.toHaveBeenCalled();
    for (let index = 0; index < 2; index++) {
      const events = [];
      for await (const event of service.recognize((async function* () { yield new Uint8Array(6400); })(), new AbortController().signal)) events.push(event);
      expect(events.at(-1)).toMatchObject({ type: 'final', text: '常驻转写' });
    }
    expect(fallback.asr.recognize).not.toHaveBeenCalled(); expect(createStreamingAsr).toHaveBeenCalledOnce();
    runtime.markValidated('asr', service); runtime.markValidated('tts', service);
    const proof = runtime.validationStatus().validationSignature;
    await runtime.configure({ ...configured, streamingInput: { ...configured.streamingInput!, vadModel: '/another-vad.onnx' } });
    expect(runtime.validationStatus()).toMatchObject({ asr: false, tts: false });
    expect(runtime.validationStatus().validationSignature).not.toBe(proof); expect(streaming.dispose).toHaveBeenCalledOnce();
    runtime.close();
  });
  it('creates a disabled local provider only for explicit validation and resets proof after model changes', async () => {
    const { assets } = assetsHarness(); const createProvider = vi.fn(idleProvider);
    const runtime = new DesktopSpeechRuntime('/unused', { assets, createProvider });
    const local = createLocalSpeechSettings();
    await runtime.configure(local);
    expect(createProvider).not.toHaveBeenCalled(); expect(runtime.service).toBeUndefined();
    const validation = runtime.serviceForValidation!;
    expect(validation).toBeDefined(); expect(createProvider).toHaveBeenCalledWith(local);
    runtime.markValidated('asr', validation); runtime.markValidated('tts', validation);
    const signature = runtime.validationStatus().validationSignature;
    await runtime.configure(structuredClone(local));
    expect(runtime.serviceForValidation).toBe(validation);
    expect(runtime.validationStatus()).toEqual({ asr: true, tts: true, validationSignature: signature });
    await runtime.configure({ ...local, enabled: true });
    expect(runtime.service).toBeDefined(); expect(runtime.usesLocalAsr).toBe(true);
    expect(runtime.validationStatus()).toEqual({ asr: true, tts: true, validationSignature: signature });
    const changed = structuredClone(local); changed.provider.asr.local.modelDirectory = '/other-model';
    await runtime.configure(changed);
    expect(runtime.validationStatus()).toMatchObject({ asr: false, tts: false }); runtime.close();
  });

  it('does no network, recognition, synthesis or asset work during configuration', async () => {
    const fetch = vi.fn(() => { throw new Error('Unexpected network request'); }); vi.stubGlobal('fetch', fetch);
    const { assets } = assetsHarness(); const provider = idleProvider(); const createProvider = vi.fn(() => provider);
    const runtime = new DesktopSpeechRuntime('/unused-test-directory', { assets, createProvider });
    await runtime.configure(settings(false)); expect(runtime.service).toBeUndefined(); expect(createProvider).not.toHaveBeenCalled();
    await runtime.configure(settings(true)); expect(runtime.service).toBeDefined();
    expect(createProvider).toHaveBeenCalledOnce(); expect(provider.asr.recognize).not.toHaveBeenCalled(); expect(provider.tts.synthesize).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled(); expect(assets.find).not.toHaveBeenCalled(); expect(assets.begin).not.toHaveBeenCalled(); runtime.close();
  });

  it('keeps the current service for identical parsed settings', async () => {
    const { assets } = assetsHarness(); const createProvider = vi.fn(idleProvider); const runtime = new DesktopSpeechRuntime('/unused', { assets, createProvider });
    await runtime.configure(settings()); const first = runtime.service;
    await runtime.configure(settings());
    expect(runtime.service).toBe(first); expect(createProvider).toHaveBeenCalledOnce(); runtime.close();
  });

  it('passes only local settings to the factory and refreshes the service on a settings change', async () => {
    const { assets } = assetsHarness(); const createProvider = vi.fn(idleProvider); const runtime = new DesktopSpeechRuntime('/unused', { assets, createProvider });
    await runtime.configure(settings()); const first = runtime.service!;
    const changed = settings(); changed.provider.tts.speechRate = 15;
    await runtime.configure(changed);
    expect(createProvider).toHaveBeenLastCalledWith(changed); expect(runtime.service).not.toBe(first);
    await expect(first.synthesize(input())).rejects.toMatchObject({ code: 'cancelled' }); runtime.close();
  });

  it.each(['model', 'voice'] as const)('cancels active synthesis when local %s configuration changes', async dimension => {
    const { assets, writer } = assetsHarness(); const old = controlledProvider(); const current = idleProvider();
    const createProvider = vi.fn().mockReturnValueOnce(old.provider).mockReturnValue(current);
    const runtime = new DesktopSpeechRuntime('/unused', { assets, createProvider });
    await runtime.configure(settings()); const first = runtime.service!;
    const run = first.synthesize(input()); const rejection = expect(run).rejects.toMatchObject({ code: 'cancelled' }); await old.entered.promise;
    const changed = settings();
    if (dimension === 'model') changed.provider.asr.local.modelDirectory = '/another-model';
    else changed.provider.tts.speechRate = 15;
    await runtime.configure(changed); await rejection;
    expect(old.signal?.aborted).toBe(true); expect(writer.abort).toHaveBeenCalledOnce(); expect(writer.complete).not.toHaveBeenCalled();
    expect(runtime.service).not.toBe(first); expect(createProvider).toHaveBeenCalledTimes(2);
    expect(createProvider).toHaveBeenLastCalledWith(changed); runtime.close();
  });

  it('cancels the old service when speech is disabled', async () => {
    const { assets, writer } = assetsHarness(); const old = controlledProvider(); const createProvider = vi.fn(() => old.provider);
    const runtime = new DesktopSpeechRuntime('/unused', { assets, createProvider });
    await runtime.configure(settings()); const first = runtime.service!;
    const run = first.synthesize(input()); const rejection = expect(run).rejects.toMatchObject({ code: 'cancelled' }); await old.entered.promise;
    await runtime.configure(settings(false)); await rejection;
    expect(old.signal?.aborted).toBe(true); expect(runtime.service).toBeUndefined(); expect(createProvider).toHaveBeenCalledOnce(); expect(writer.abort).toHaveBeenCalledOnce(); runtime.close();
  });

  it('closes assets exactly once, cancels active requests, and cannot be reconfigured after close', async () => {
    const { assets } = assetsHarness(); const old = controlledProvider(); const createProvider = vi.fn(() => old.provider);
    const runtime = new DesktopSpeechRuntime('/unused', { assets, createProvider });
    await runtime.configure(settings()); const run = runtime.service!.synthesize(input()); const rejection = expect(run).rejects.toMatchObject({ code: 'cancelled' }); await old.entered.promise;
    runtime.close(); runtime.close(); await rejection;
    expect(assets.close).toHaveBeenCalledOnce(); expect(old.signal?.aborted).toBe(true); expect(runtime.service).toBeUndefined();
    await expect(runtime.configure(settings())).rejects.toThrow('Speech runtime is closed'); expect(createProvider).toHaveBeenCalledOnce();
  });

  it('releases only the requested owner through the Worker-owned asset store', async () => {
    const { assets } = assetsHarness(); const runtime = new DesktopSpeechRuntime('/unused', { assets, createProvider: vi.fn(idleProvider) });
    await runtime.releaseOwner(owner); expect(assets.releaseOwner).toHaveBeenCalledWith(owner); expect(assets.clear).not.toHaveBeenCalled(); runtime.close();
  });

  it('does not resurrect a service when close races with an asynchronous cache clear', async () => {
    const { assets } = assetsHarness(); const gate = deferred<void>(); vi.mocked(assets.clear).mockReturnValue(gate.promise);
    const createProvider = vi.fn(idleProvider); const runtime = new DesktopSpeechRuntime('/unused', { assets, createProvider });
    const clearing = runtime.clearCache(); const configuring = runtime.configure(settings()); runtime.close(); gate.resolve();
    await Promise.all([clearing, configuring]);
    expect(runtime.service).toBeUndefined(); expect(createProvider).not.toHaveBeenCalled(); expect(assets.close).toHaveBeenCalledOnce();
  });

  it('keeps the latest disabled state when configure calls overlap during cache clearing', async () => {
    const { assets } = assetsHarness(); const gate = deferred<void>(); vi.mocked(assets.clear).mockReturnValue(gate.promise);
    const createProvider = vi.fn(idleProvider); const runtime = new DesktopSpeechRuntime('/unused', { assets, createProvider });
    const clearing = runtime.clearCache(); const enabled = runtime.configure(settings(true)); const disabled = runtime.configure(settings(false));
    gate.resolve(); await Promise.all([clearing, enabled, disabled]);
    expect(runtime.service).toBeUndefined(); expect(createProvider).not.toHaveBeenCalled(); runtime.close();
  });

  it('selects a separate preset service without changing the default voice or granting global TTS validation', async () => {
    const { assets } = assetsHarness(); const createProvider = vi.fn(idleProvider);
    const runtime = new DesktopSpeechRuntime('/unused', { assets, createProvider });
    const configuration = SpeechSettingsSchema.parse({ enabled: true, voicePresets: [{ id: 'morning', name: '早间', speakerId: 'morning-speaker', speechRate: 15 }] });
    await runtime.configure(configuration);
    const selected = runtime.serviceForPreset('morning')!;
    expect(selected).toBe(runtime.serviceForPreset('morning')); expect(selected).not.toBe(runtime.service);
    expect(createProvider).toHaveBeenLastCalledWith(expect.objectContaining({ provider: expect.objectContaining({
      tts: expect.objectContaining({ speakerId: 'morning-speaker', speechRate: 15 })
    }) }));
    await selected.synthesize(input());
    expect(runtime.diagnostics().tts).toMatchObject({ requests: 1, completed: 1, requestedChars: 2, audioBytes: 2 });
    runtime.markValidated('tts', selected); runtime.markValidated('tts', runtime.serviceForPresetValidation('morning')!);
    expect(runtime.validationStatus().tts).toBe(false);
    runtime.markValidated('tts', runtime.service!); expect(runtime.validationStatus().tts).toBe(true);
    expect(() => runtime.serviceForPreset('deleted')).toThrowError(expect.objectContaining({ code: 'speaker_unavailable' }));
    runtime.close(); await expect(selected.synthesize(input())).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('allows explicit preset validation while disabled, then disposes every preset on local configuration changes', async () => {
    const { assets } = assetsHarness(); const createProvider = vi.fn(idleProvider);
    const runtime = new DesktopSpeechRuntime('/unused', { assets, createProvider });
    const configuration = SpeechSettingsSchema.parse({ voicePresets: [{ id: 'morning', name: '早间', speakerId: 'morning-speaker' }] });
    await runtime.configure(configuration);
    expect(runtime.serviceForPreset('morning')).toBeUndefined(); expect(createProvider).not.toHaveBeenCalled();
    const selected = runtime.serviceForPresetValidation('morning')!; await selected.synthesize(input());
    runtime.markValidated('tts', selected); expect(runtime.validationStatus().tts).toBe(false);
    const changed = structuredClone(configuration); changed.voicePresets[0]!.speechRate = 10; await runtime.configure(changed);
    await expect(selected.synthesize(input())).rejects.toMatchObject({ code: 'cancelled' });
    expect(runtime.serviceForPresetValidation('morning')).not.toBe(selected); runtime.close();
  });

  it('preserves active reminder synthesis, preset services and validation when only automatic reading consent changes', async () => {
    const { assets } = assetsHarness(); const active = controlledProvider(); const createProvider = vi.fn(() => active.provider);
    const runtime = new DesktopSpeechRuntime('/unused', { assets, createProvider });
    const configuration = SpeechSettingsSchema.parse({ enabled: true, autoReadReplies: true,
      voicePresets: [{ id: 'morning', name: '早间', speakerId: 'morning-speaker' }] });
    await runtime.configure(configuration);
    const service = runtime.service!, preset = runtime.serviceForPreset('morning')!;
    runtime.markValidated('asr', service); runtime.markValidated('tts', service);
    const before = runtime.validationStatus(), invalidated = vi.fn(); runtime.onInvalidated(invalidated);
    const synthesis = preset.synthesize({ ...input(), owner: { kind: 'schedule', id: 'independent-reminder' } });
    const rejection = expect(synthesis).rejects.toMatchObject({ code: 'cancelled' }); await active.entered.promise;
    await runtime.configure({ ...configuration, autoReadReplies: false });
    expect(runtime.service).toBe(service); expect(runtime.serviceForPreset('morning')).toBe(preset);
    expect(active.signal?.aborted).toBe(false); expect(invalidated).not.toHaveBeenCalled();
    expect(runtime.validationStatus()).toEqual(before); expect(createProvider).toHaveBeenCalledTimes(2);
    await runtime.configure(configuration); expect(active.signal?.aborted).toBe(false); expect(invalidated).not.toHaveBeenCalled();
    runtime.close(); await rejection;
  });

  it('keeps explicit local validation available while disabled when only automatic reading changes', async () => {
    const { assets } = assetsHarness(); const createProvider = vi.fn(idleProvider);
    const runtime = new DesktopSpeechRuntime('/unused', { assets, createProvider });
    const configuration = settings(false); await runtime.configure(configuration);
    const validation = runtime.serviceForValidation!; runtime.markValidated('asr', validation); runtime.markValidated('tts', validation);
    const before = runtime.validationStatus(), invalidated = vi.fn(); runtime.onInvalidated(invalidated);
    await runtime.configure({ ...configuration, autoReadReplies: true });
    expect(runtime.service).toBeUndefined(); expect(runtime.serviceForValidation).toBe(validation);
    expect(runtime.validationStatus()).toEqual(before); expect(invalidated).not.toHaveBeenCalled(); expect(createProvider).toHaveBeenCalledOnce(); runtime.close();
  });

  it('clears cached audio, aborts active synthesis and remains usable with the same configuration', async () => {
    const { assets } = assetsHarness(); const old = controlledProvider();
    const createProvider = vi.fn().mockReturnValueOnce(old.provider).mockImplementation(idleProvider);
    const runtime = new DesktopSpeechRuntime('/unused', { assets, createProvider });
    await runtime.configure(settings());
    const invalidated = vi.fn(); runtime.onInvalidated(invalidated);
    const first = runtime.service!; const running = first.synthesize(input()); const rejection = expect(running).rejects.toMatchObject({ code: 'cancelled' });
    await old.entered.promise; await runtime.clearCache(); await rejection;
    expect(old.signal?.aborted).toBe(true); expect(assets.clear).toHaveBeenCalledOnce(); expect(invalidated).toHaveBeenCalledOnce();
    expect(runtime.service).toBeDefined(); expect(runtime.service).not.toBe(first);
    await expect(runtime.service!.synthesize(input())).resolves.toBe(asset); runtime.close();
  });
});
