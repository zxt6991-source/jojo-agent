import { describe, expect, it, vi } from 'vitest';
import { SpeechDiagnosticsSchema, SpeechSettingsSchema, SpeechProviderError, type AudioAsset, type SpeechAssetStore, type SpeechProvider } from '@desktop-agent/contracts';
import { SpeechDiagnosticsCollector } from '../src/metrics.js';
import { SpeechService } from '../src/service.js';

function fixture() {
  const metrics = new SpeechDiagnosticsCollector(new Date('2026-10-15T00:00:00.000Z'));
  const asset: AudioAsset = { id: crypto.randomUUID(), owner: { kind: 'test', id: 'metrics' },
    format: 'wav', sampleRate: 24000, bytes: 3, createdAt: 0, expiresAt: 9_999 };
  const assets: SpeechAssetStore = { find: vi.fn(async () => undefined), begin: vi.fn(async () => ({
    append: async () => undefined, complete: async () => asset, abort: async () => undefined
  })), release: async () => undefined, releaseOwner: async () => undefined, clear: async () => undefined };
  const provider: SpeechProvider = {
    asr: { async *recognize(input) {
      for await (const _chunk of input.audio) { void _chunk; }
      yield { type: 'final', requestId: input.requestId, text: 'private-transcript' };
    } },
    tts: { async *synthesize(input) {
      yield { type: 'audio', requestId: input.requestId, bytes: Uint8Array.of(1, 2, 3), format: 'wav', sampleRate: 24000 };
      yield { type: 'completed', requestId: input.requestId };
    } }
  };
  const service = new SpeechService({ settings: SpeechSettingsSchema.parse({}), provider, assets, onMetric: event => metrics.record(event) });
  return { metrics, assets, provider, service, asset };
}

describe('bounded speech diagnostics', () => {
  it('counts consumed PCM, Unicode requested characters, actual bytes without storing private text', async () => {
    const f = fixture();
    for await (const _event of f.service.recognize((async function* () { yield new Uint8Array(6_400); })(), new AbortController().signal)) { void _event; }
    await f.service.synthesize({ text: '你好🙂', owner: f.asset.owner, signal: new AbortController().signal });
    const result = f.metrics.snapshot();
    expect(result.asr).toMatchObject({ requests: 1, completed: 1, audioMs: 200 });
    expect(result.tts).toMatchObject({ requests: 1, completed: 1, requestedChars: 3, audioBytes: 3, cacheHits: 0 });
    expect(JSON.stringify(result)).not.toMatch(/你好|private-transcript|apiKey|speakerId/u);
    expect(SpeechDiagnosticsSchema.safeParse(result).success).toBe(true);
  });
  it('counts a ready cache hit without inventing a provider request', async () => {
    const f = fixture(); vi.mocked(f.assets.find).mockResolvedValue(f.asset);
    await f.service.synthesize({ text: '缓存文本', owner: f.asset.owner, signal: new AbortController().signal });
    expect(f.metrics.snapshot().tts).toMatchObject({ requests: 0, requestedChars: 0, cacheHits: 1 });
  });
  it('distinguishes failed and cancelled requests and tolerates a broken diagnostics observer', async () => {
    const f = fixture();
    f.provider.tts.synthesize = () => { throw new SpeechProviderError('network_error', 'controlled'); };
    await expect(f.service.synthesize({ text: '失败', owner: f.asset.owner, signal: new AbortController().signal })).rejects.toThrow('controlled');
    f.provider.tts.synthesize = () => { throw new SpeechProviderError('cancelled', 'cancelled'); };
    await expect(f.service.synthesize({ text: '取消', owner: f.asset.owner, signal: new AbortController().signal })).rejects.toThrow('cancelled');
    expect(f.metrics.snapshot().tts).toMatchObject({ requests: 2, failed: 1, cancelled: 1 });
    const healthy = fixture();
    const service = new SpeechService({ settings: SpeechSettingsSchema.parse({}), provider: healthy.provider, assets: healthy.assets, onMetric() { throw new Error('observer'); } });
    await expect(service.synthesize({ text: '成功', owner: healthy.asset.owner, signal: new AbortController().signal })).resolves.toEqual(healthy.asset);
  });
  it('bounds timing samples to the latest 100 and returns isolated snapshots', () => {
    const metrics = fixture().metrics;
    for (let i = 1; i <= 120; i++) metrics.record({ kind: 'tts', outcome: 'completed', providerRequested: true, durationMs: i });
    const result = metrics.snapshot();
    expect(result.tts).toMatchObject({ requests: 120, samples: 100, meanMs: 70.5, p95Ms: 115 });
    result.tts.requests = 0;
    expect(metrics.snapshot().tts.requests).toBe(120);
  });
});
