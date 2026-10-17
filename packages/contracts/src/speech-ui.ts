import { z } from 'zod';
import { AudioAssetOwnerSchema, AudioAssetSchema, SPEECH_LIMITS, SpeechErrorCodeSchema } from './speech.js';
import { SpeechDiagnosticsSchema } from './speech-metrics.js';

const Id = z.string().min(1).max(256);
const Generation = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const CaptureFields = { captureId: Id, voiceTurnId: Id, generation: Generation,
  sessionId: Id.optional(), purpose: z.enum(['conversation', 'validation']) };

export const BeginSpeechCaptureInputSchema = z.object({
  sessionId: Id.optional(), purpose: z.enum(['conversation', 'validation']), generation: Generation
}).strict().refine(value => value.purpose !== 'conversation' || Boolean(value.sessionId), 'A conversation requires a session.');
export type BeginSpeechCaptureInput = z.infer<typeof BeginSpeechCaptureInputSchema>;
export const SpeechCaptureHandleSchema = z.object(CaptureFields).strict();
export type SpeechCaptureHandle = z.infer<typeof SpeechCaptureHandleSchema>;
export const SpeechCaptureCancelInputSchema = SpeechCaptureHandleSchema;

const StreamIdentity = { captureId: Id, generation: Generation };
/** Binary frames are used exclusively on the dedicated audio MessagePort. */
export const SpeechAudioFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('audio'), ...StreamIdentity,
    sequence: z.number().int().positive(), bytes: z.instanceof(Uint8Array).refine(bytes =>
      bytes.byteLength > 0 && bytes.byteLength <= SPEECH_LIMITS.maxChunkBytes && bytes.byteLength % 2 === 0)
  }).strict(),
  z.object({ type: z.literal('end'), ...StreamIdentity, lastSequence: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal('cancel'), ...StreamIdentity }).strict()
]);
export type SpeechAudioFrame = z.infer<typeof SpeechAudioFrameSchema>;
export const SpeechAudioAckSchema = z.object({ type: z.literal('ack'), ...StreamIdentity,
  sequence: z.number().int().positive() }).strict();
export type SpeechAudioAck = z.infer<typeof SpeechAudioAckSchema>;

export const CommitVoiceTurnInputSchema = z.object({
  voiceTurnId: Id, generation: Generation, sessionId: Id,
  text: z.string().trim().min(1).max(20_000), providerId: Id, model: z.string().min(1).max(512)
}).strict();
export type CommitVoiceTurnInput = z.infer<typeof CommitVoiceTurnInputSchema>;
export const VoiceCommitResultSchema = z.object({
  voiceTurnId: Id, generation: Generation, sessionId: Id, runId: Id.optional(),
  status: z.enum(['committed', 'pending', 'failed']), reason: z.string().max(1_000).optional()
}).strict();
export type VoiceCommitResult = z.infer<typeof VoiceCommitResultSchema>;
export const ReadSpeechMessageInputSchema = z.object({ sessionId: Id, messageId: Id, generation: Generation,
  automatic: z.boolean().optional(), offset: Generation.optional() }).strict();
export type ReadSpeechMessageInput = z.infer<typeof ReadSpeechMessageInputSchema>;
export const ReadApprovalSpeechInputSchema = z.object({ sessionId: Id, approvalId: Id, generation: Generation }).strict();
export type ReadApprovalSpeechInput = z.infer<typeof ReadApprovalSpeechInputSchema>;
export const TestSpeechSettingsInputSchema = z.object({ generation: Generation, presetId: Id.optional() }).strict();
export type TestSpeechSettingsInput = z.infer<typeof TestSpeechSettingsInputSchema>;
export const StopSpeechPlaybackInputSchema = z.object({
  sessionId: Id.optional(), playbackId: Id.optional(), generation: Generation.optional()
}).strict();
export type StopSpeechPlaybackInput = z.infer<typeof StopSpeechPlaybackInputSchema>;
export const SpeechPlaybackResultSchema = z.object({ playbackId: Id, generation: Generation, nextOffset: Generation.optional() }).strict();
export type SpeechPlaybackResult = z.infer<typeof SpeechPlaybackResultSchema>;
export const SpeechCaptureStateSchema = z.object({ ...CaptureFields,
  state: z.enum(['connecting', 'ready', 'recording', 'recognizing', 'review', 'cancelled', 'failed']),
  text: z.string().max(20_000).optional(), errorCode: SpeechErrorCodeSchema.optional(),
  reason: z.string().max(1_000).optional(), durationMs: z.number().nonnegative().max(60_200).optional()
}).strict();
export type SpeechCaptureState = z.infer<typeof SpeechCaptureStateSchema>;
export const SpeechPlaybackStateSchema = z.object({
  playbackId: Id, generation: Generation, sessionId: Id.optional(), messageId: Id.optional(),
  nextOffset: Generation.optional(),
  state: z.enum(['queued', 'preparing', 'playing', 'played', 'interrupted', 'failed', 'suppressed']),
  reason: z.string().max(1_000).optional()
}).strict();
export type SpeechPlaybackState = z.infer<typeof SpeechPlaybackStateSchema>;
export const SpeechValidationSchema = z.object({ asr: z.boolean(), tts: z.boolean() }).strict();
export const SpeechStatusSchema = z.object({
  captures: z.array(SpeechCaptureStateSchema).max(100),
  playbacks: z.array(SpeechPlaybackStateSchema).max(100), validation: SpeechValidationSchema,
  diagnostics: SpeechDiagnosticsSchema.optional()
}).strict();
export type SpeechStatus = z.infer<typeof SpeechStatusSchema>;
export const SpeechEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('reply'), sessionId: Id, messageId: Id, runId: Id }).strict(),
  SpeechCaptureStateSchema.extend({ type: z.literal('capture') }),
  VoiceCommitResultSchema.extend({ type: z.literal('commit') }),
  SpeechPlaybackStateSchema.extend({ type: z.literal('playback') }),
  SpeechValidationSchema.extend({ type: z.literal('validation') })
]);
export type SpeechEvent = z.infer<typeof SpeechEventSchema>;

/** Main/Worker control plane only. Paths never cross the main-window bridge. */
export const SpeechReadyAssetSchema = z.object({ asset: AudioAssetSchema, path: z.string().min(1).max(8_192),
  spokenText: z.string().max(1_200).optional(), truncated: z.boolean().optional(), nextOffset: Generation.optional() }).strict();
export const ResolveSpeechAssetInputSchema = z.object({ assetId: z.string().uuid(), owner: AudioAssetOwnerSchema }).strict();
