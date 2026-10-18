import { z } from 'zod';

export const SPEECH_PROTOCOL_VERSION = 1;
export const SPEECH_TEXT_VERSION = 1;
/** Built-in Qwen voices. Default is the same gentle Chinese voice as Serena. */
export const LOCAL_NEURAL_VOICES = ['Serena', 'Vivian', 'Uncle_Fu', 'Dylan', 'Eric', 'Ryan', 'Aiden', 'Ono_Anna', 'Sohee'] as const;
export const SPEECH_LIMITS = {
  captureMs: 60_000, captureBytes: 1_926_400, pcmChunkBytes: 6_400,
  maxChunkBytes: 256 * 1024, asrMessageBytes: 1024 * 1024,
  ttsBytes: 8 * 1024 * 1024, autoReadChars: 600, localReadChars: 200, reminderChars: 200,
  cacheBytes: 256 * 1024 * 1024, cacheAgeMs: 7 * 24 * 60 * 60 * 1000
} as const;

const QuietHoursSchema = z.object({
  start: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u),
  end: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u),
  timezone: z.string().min(1).max(128).refine((value) => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
  }, 'Invalid IANA timezone.')
}).strict();

export const SpeechVoicePresetSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u),
  name: z.string().trim().min(1).max(80),
  speakerId: z.string().trim().min(1).max(256),
  speechRate: z.number().int().min(-50).max(100).default(0)
}).strict();
export type SpeechVoicePreset = z.infer<typeof SpeechVoicePresetSchema>;

export const SpeechSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  inputMode: z.enum(['review', 'auto_send']).default('review'),
  autoReadReplies: z.boolean().default(false),
  realtimeReplies: z.boolean().default(false),
  streamingInput: z.object({
    enabled: z.boolean().default(false),
    vadModel: z.string().trim().max(4096).refine(value => !value.includes('\0')).default(''),
    paraformerDirectory: z.string().trim().max(4096).refine(value => !value.includes('\0')).default(''),
    smartTurnModel: z.string().trim().max(4096).refine(value => !value.includes('\0')).optional(),
    autoEndpoint: z.boolean().optional(),
    fallbackTimeoutMs: z.number().int().min(500).max(10_000).optional()
  }).strict().optional(),
  voiceResponseModel: z.object({ providerId: z.string().min(1).max(256), model: z.string().min(1).max(512) }).strict().optional(),
  backgroundRunning: z.boolean().default(false),
  voicePresets: z.array(SpeechVoicePresetSchema).max(20).default([]).refine(
    presets => new Set(presets.map(preset => preset.id)).size === presets.length, 'Voice preset ids must be unique.'),
  inputDeviceId: z.string().min(1).max(512).optional(),
  provider: z.object({
    asr: z.object({
      id: z.literal('sensevoice').default('sensevoice'),
      local: z.object({
        pythonPath: z.string().trim().min(1).max(4096).refine(value => !value.includes('\0'), 'Invalid Python executable.').default('python3'),
        modelDirectory: z.string().trim().max(4096).refine(value => !value.includes('\0'), 'Invalid model directory.').default(''),
        language: z.enum(['auto', 'zh', 'en', 'ja', 'ko', 'yue']).default('auto')
      }).strict().prefault({}),
      mode: z.literal('utterance').default('utterance'),
      audio: z.object({
        format: z.literal('pcm').default('pcm'), sampleRate: z.literal(16000).default(16000),
        channels: z.literal(1).default(1), bits: z.literal(16).default(16)
      }).strict().prefault({})
    }).strict().prefault({}),
    tts: z.object({
      id: z.enum(['macos', 'mlx-qwen3']).default('macos'),
      speakerId: z.string().trim().min(1).max(256).default('default'),
      format: z.literal('wav').default('wav'), sampleRate: z.literal(24000).default(24000),
      speechRate: z.number().int().min(-50).max(100).default(0),
      local: z.object({
        pythonPath: z.string().trim().min(1).max(4096).refine(value => !value.includes('\0')),
        modelDirectory: z.string().trim().max(4096).refine(value => !value.includes('\0'))
      }).strict().optional()
    }).strict().superRefine((tts, ctx) => {
      if (tts.id === 'mlx-qwen3') {
        if (!tts.local) ctx.addIssue({ code: 'custom', path: ['local'], message: 'Choose the local neural voice runtime and model.' });
        if (tts.speechRate !== 0) ctx.addIssue({ code: 'custom', path: ['speechRate'], message: 'This neural voice uses its original speaking rate.' });
        if (tts.speakerId !== 'default' && !LOCAL_NEURAL_VOICES.includes(tts.speakerId as typeof LOCAL_NEURAL_VOICES[number])) ctx.addIssue({ code: 'custom', path: ['speakerId'], message: 'Choose a supported neural voice.' });
      }
    }).prefault({})
  }).strict().prefault({}),
  playback: z.object({
    volume: z.number().min(0).max(1).default(1), muteWhenLocked: z.boolean().default(true),
    quietHours: QuietHoursSchema.optional()
  }).strict().prefault({})
}).strict();
export type SpeechSettings = z.infer<typeof SpeechSettingsSchema>;

/** Local speech is disabled until explicitly validated and enabled. */
export function createLocalSpeechSettings(): SpeechSettings {
  return SpeechSettingsSchema.parse({});
}

/** Presets override voice parameters only; ASR always uses the shared configuration. */
export function resolveSpeechPresetSettings(settings: SpeechSettings, presetId?: string): SpeechSettings {
  if (!presetId) return settings;
  const preset = settings.voicePresets.find(value => value.id === presetId);
  if (!preset) throw new SpeechProviderError('speaker_unavailable', 'The selected voice preset is unavailable.');
  return { ...settings, provider: { ...settings.provider, tts: {
    ...settings.provider.tts, speakerId: preset.speakerId, speechRate: preset.speechRate
  } } };
}
export const SpeechSettingsSnapshotSchema = z.object({ settings: SpeechSettingsSchema }).strict();
export type SpeechSettingsSnapshot = z.infer<typeof SpeechSettingsSnapshotSchema>;

export const PcmInputFormatSchema = z.object({
  codec: z.literal('pcm16le'), sampleRate: z.literal(16000), channels: z.literal(1)
}).strict();
export type PcmInputFormat = z.infer<typeof PcmInputFormatSchema>;
export const SpeechEndpointReasonSchema = z.enum(['smart_turn', 'silence_timeout']);
export type SpeechEndpointReason = z.infer<typeof SpeechEndpointReasonSchema>;
export type AsrEvent =
  | { type: 'ready'; requestId: string }
  | { type: 'endpoint'; requestId: string; reason: SpeechEndpointReason }
  | { type: 'partial'; requestId: string; revision: number; text: string }
  | { type: 'final'; requestId: string; text: string; durationMs?: number };
export interface SpeechAsrProvider {
  recognize(input: { requestId: string; format: PcmInputFormat; audio: AsyncIterable<Uint8Array>; signal: AbortSignal }): AsyncIterable<AsrEvent>;
}
export type TtsEvent =
  | { type: 'audio'; requestId: string; bytes: Uint8Array; format: 'mp3' | 'wav'; sampleRate: 24000 }
  | { type: 'completed'; requestId: string };
export interface SpeechTtsProvider {
  synthesize(input: { requestId: string; text: string; speakerId: string; speechRate: number; signal: AbortSignal }): AsyncIterable<TtsEvent>;
}
export interface SpeechProvider { asr: SpeechAsrProvider; tts: SpeechTtsProvider }

export const SpeechErrorCodeSchema = z.enum([
  'auth_failed', 'resource_denied', 'speaker_unavailable', 'invalid_audio', 'empty_result',
  'rate_limited', 'timeout', 'network_error', 'protocol_error', 'cancelled', 'local_unavailable',
  'synthesis_failed', 'synthesis_limit'
]);
export type SpeechErrorCode = z.infer<typeof SpeechErrorCodeSchema>;
export interface SpeechErrorDetails {
  requestId?: string; vendorCode?: string | number; logId?: string; retryable?: boolean;
}
/** Messages are controlled, redacted reasons, never raw provider bodies or credentials. */
export class SpeechProviderError extends Error {
  readonly code: SpeechErrorCode;
  readonly requestId?: string;
  readonly vendorCode?: string | number;
  readonly logId?: string;
  readonly retryable: boolean;
  constructor(code: SpeechErrorCode, message: string, details: SpeechErrorDetails = {}) {
    super(message); this.name = 'SpeechProviderError'; this.code = code;
    if (details.requestId !== undefined) this.requestId = details.requestId;
    if (details.vendorCode !== undefined) this.vendorCode = details.vendorCode;
    if (details.logId !== undefined) this.logId = details.logId;
    this.retryable = details.retryable ?? false;
  }
}

export const AudioAssetOwnerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), id: z.string().min(1).max(256) }).strict(),
  z.object({ kind: z.literal('schedule'), id: z.string().min(1).max(256) }).strict(),
  z.object({ kind: z.literal('test'), id: z.string().min(1).max(256) }).strict()
]);
export type AudioAssetOwner = z.infer<typeof AudioAssetOwnerSchema>;
export const AudioAssetSchema = z.object({
  id: z.string().uuid(), owner: AudioAssetOwnerSchema, format: z.enum(['mp3', 'wav']),
  sampleRate: z.literal(24000), bytes: z.number().int().positive().max(SPEECH_LIMITS.ttsBytes),
  createdAt: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative()
}).strict();
export type AudioAsset = z.infer<typeof AudioAssetSchema>;
export interface AudioAssetWriter {
  append(bytes: Uint8Array): Promise<void>;
  complete(): Promise<AudioAsset>;
  abort(): Promise<void>;
}
export interface SpeechAssetStore {
  find(cacheKey: string, owner: AudioAssetOwner): Promise<AudioAsset | undefined>;
  begin(cacheKey: string, owner: AudioAssetOwner, format?: 'mp3' | 'wav'): Promise<AudioAssetWriter>;
  release(asset: AudioAsset): Promise<void>;
  releaseOwner(owner: AudioAssetOwner): Promise<void>;
  clear(): Promise<void>;
}
export const SaveSpeechSettingsInputSchema = z.object({
  settings: SpeechSettingsSchema
}).strict();
export type SaveSpeechSettingsInput = z.infer<typeof SaveSpeechSettingsInputSchema>;
