import { z } from 'zod';

const Count = z.number().int().nonnegative().safe();
const Timing = z.object({
  requests: Count, completed: Count, failed: Count, cancelled: Count,
  meanMs: z.number().nonnegative(), p95Ms: z.number().nonnegative(), samples: Count
}).strict();
export const SpeechDiagnosticsSchema = z.object({
  startedAt: z.string().datetime(),
  asr: Timing.extend({ audioMs: z.number().nonnegative() }).strict(),
  tts: Timing.extend({ requestedChars: Count, audioBytes: Count, cacheHits: Count }).strict()
}).strict();
export type SpeechDiagnostics = z.infer<typeof SpeechDiagnosticsSchema>;
/** Numeric observations only. Never include text, asset paths or credentials. */
export interface SpeechMetricEvent {
  kind: 'asr' | 'tts'; outcome: 'completed' | 'failed' | 'cancelled' | 'cache_hit';
  providerRequested: boolean; durationMs: number; audioMs?: number;
  requestedChars?: number; audioBytes?: number;
}
