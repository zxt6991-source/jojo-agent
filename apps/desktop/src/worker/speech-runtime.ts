import {
  SpeechSettingsSchema, resolveSpeechPresetSettings, type SpeechSettings, type SpeechProvider,
  type SpeechAssetStore, type AudioAssetOwner, type AudioAsset
} from '@desktop-agent/contracts';
import { createSpeechProvider } from '@desktop-agent/providers';
import { SpeechService, SpeechDiagnosticsCollector } from '@desktop-agent/speech';
import { SqliteSpeechAssetStore, type ReadySpeechAsset } from '@desktop-agent/storage';
import { createHash } from 'node:crypto';
import path from 'node:path';

interface ClosableAssets extends SpeechAssetStore { close(): void; getReadyAsset?(id: string, owner: AudioAssetOwner): Promise<ReadySpeechAsset | undefined> }
export interface DesktopSpeechRuntimeOptions {
  assets?: ClosableAssets;
  createProvider?: (settings: SpeechSettings) => SpeechProvider;
}

/** Worker owns active requests and the asset database. Configuration does no networking. */
export class DesktopSpeechRuntime {
  private readonly assets: ClosableAssets;
  private readonly createProvider: NonNullable<DesktopSpeechRuntimeOptions['createProvider']>;
  private signature: string | undefined;
  private current: SpeechService | undefined;
  private validationCurrent: SpeechService | undefined;
  private readonly presetServices = new Map<string, SpeechService>();
  private readonly presetValidationServices = new Map<string, SpeechService>();
  private readonly metrics = new SpeechDiagnosticsCollector();
  private validationConfiguration: { settings: SpeechSettings } | undefined;
  private clearing: Promise<void> | undefined;
  private verificationSignature: string | undefined;
  private verified = { asr: false, tts: false };
  private readonly invalidationListeners = new Set<() => void>();
  private readonly validationListeners = new Set<(validation: { asr: boolean; tts: boolean }) => void>();
  private generation = 0;
  private closed = false;
  constructor(dataDirectory: string, options: DesktopSpeechRuntimeOptions = {}) {
    this.assets = options.assets ?? new SqliteSpeechAssetStore(path.join(dataDirectory, 'runtime', 'speech.sqlite'));
    this.createProvider = options.createProvider ?? createSpeechProvider;
  }
  get service(): SpeechService | undefined { return this.current; }
  get usesLocalAsr(): boolean { return this.validationConfiguration?.settings.provider.asr.id === 'sensevoice'; }
  diagnostics() { return this.metrics.snapshot(); }
  private createService(settings: SpeechSettings): SpeechService {
    return new SpeechService({ settings, assets: this.assets, provider: this.createProvider(settings), onMetric: event => this.metrics.record(event) });
  }
  serviceForPreset(presetId?: string): SpeechService | undefined {
    if (!presetId) return this.current;
    return this.presetService(presetId, false);
  }
  serviceForPresetValidation(presetId?: string): SpeechService | undefined {
    if (!presetId) return this.serviceForValidation;
    return this.presetService(presetId, true);
  }
  private presetService(presetId: string, validation: boolean): SpeechService | undefined {
    if (this.closed || this.clearing || !this.validationConfiguration) return undefined;
    const { settings } = this.validationConfiguration;
    const selected = resolveSpeechPresetSettings(settings, presetId);
    if (!validation && !settings.enabled) return undefined;
    const services = validation ? this.presetValidationServices : this.presetServices;
    let service = services.get(presetId);
    if (!service) {
      service = this.createService(selected);
      services.set(presetId, service);
    }
    return service;
  }
  /** Tests are explicit user operations. Disabled configuration alone stays offline. */
  get serviceForValidation(): SpeechService | undefined {
    if (this.closed || this.clearing) return undefined;
    if (this.current) return this.current;
    if (!this.validationCurrent && this.validationConfiguration) {
      const { settings } = this.validationConfiguration;
      this.validationCurrent = this.createService(settings);
    }
    return this.validationCurrent;
  }
  onInvalidated(listener: () => void): () => void {
    this.invalidationListeners.add(listener); return () => this.invalidationListeners.delete(listener);
  }
  onValidationChanged(listener: (validation: { asr: boolean; tts: boolean }) => void): () => void {
    this.validationListeners.add(listener); return () => this.validationListeners.delete(listener);
  }
  markValidated(kind: 'asr' | 'tts', service: SpeechService): void {
    if (!this.closed && !this.verified[kind] && (service === this.current || service === this.validationCurrent)) {
      this.verified[kind] = true; for (const listener of this.validationListeners) listener({ ...this.verified });
    }
  }
  validationStatus(): { asr: boolean; tts: boolean; validationSignature?: string } {
    return { ...this.verified, ...(this.verificationSignature ? { validationSignature: this.verificationSignature } : {}) };
  }
  async resolveAsset(id: string, owner: AudioAssetOwner): Promise<ReadySpeechAsset | undefined> {
    if (this.closed) return undefined;
    return this.assets.getReadyAsset?.(id, owner);
  }
  releaseAsset(asset: AudioAsset): Promise<void> { return this.assets.release(asset); }

  private disposeServices(): void {
    this.current?.dispose(); this.current = undefined;
    this.validationCurrent?.dispose(); this.validationCurrent = undefined;
    for (const service of this.presetServices.values()) service.dispose();
    for (const service of this.presetValidationServices.values()) service.dispose();
    this.presetServices.clear(); this.presetValidationServices.clear();
  }

  /** Cancel in-flight synthesis before deleting its assets; the same configuration remains usable. */
  clearCache(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Speech runtime is closed.'));
    if (this.clearing) return this.clearing;
    for (const listener of this.invalidationListeners) listener();
    this.disposeServices();
    const generation = ++this.generation;
    const clearing = this.assets.clear().finally(() => {
      if (this.clearing !== clearing) return;
      this.clearing = undefined;
      if (this.closed || generation !== this.generation || !this.validationConfiguration) return;
      const { settings } = this.validationConfiguration;
      if (settings.enabled) this.current = this.createService(settings);
    });
    this.clearing = clearing;
    return clearing;
  }

  async configure(settings: SpeechSettings): Promise<void> {
    if (this.closed) throw new Error('Speech runtime is closed.');
    const parsed = SpeechSettingsSchema.parse(settings);
    // Automatic reply consent belongs to Main's playback gate. Changing only
    // that preference must not abort microphone work or independent reminders.
    const signature = JSON.stringify({ ...parsed, autoReadReplies: false });
    if (signature === this.signature) {
      if (this.validationConfiguration) this.validationConfiguration = { settings: parsed };
      return;
    }
    for (const listener of this.invalidationListeners) listener();
    this.disposeServices();
    this.validationConfiguration = undefined;
    this.current = undefined;
    const generation = ++this.generation;
    this.signature = signature;
    if (this.clearing) await this.clearing;
    if (this.closed || generation !== this.generation) return;
    const verificationSignature = createHash('sha256').update(JSON.stringify(parsed.provider)).digest('hex');
    if (verificationSignature !== this.verificationSignature) {
      this.verified = { asr: false, tts: false }; for (const listener of this.validationListeners) listener({ ...this.verified });
    }
    this.verificationSignature = verificationSignature;
    this.validationConfiguration = { settings: parsed };
    if (!parsed.enabled) return;
    this.current = this.createService(parsed);
  }

  releaseOwner(owner: AudioAssetOwner): Promise<void> { return this.assets.releaseOwner(owner); }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.invalidationListeners) listener(); this.invalidationListeners.clear();
    this.validationListeners.clear();
    this.disposeServices(); this.validationConfiguration = undefined;
    this.assets.close();
  }
}
