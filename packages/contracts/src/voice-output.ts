import { z } from 'zod';
const Id = z.string().min(1).max(256);
export const VoiceOutputHandleSchema = z.object({ sessionId: Id, runId: Id, generation: z.number().int().nonnegative().safe() }).strict();
export type VoiceOutputHandle = z.infer<typeof VoiceOutputHandleSchema>;
/** Only dedicated MessagePorts carry PCM. These frames never enter JSON IPC. */
export const VoiceOutputFrameSchema = z.discriminatedUnion('type', [
  VoiceOutputHandleSchema.extend({ type: z.literal('pcm'), segmentId: Id, sequence: z.number().int().positive().safe(),
    pcm: z.instanceof(Uint8Array).refine(bytes => bytes.byteLength > 0 && bytes.byteLength <= 256 * 1024 && bytes.byteLength % 2 === 0),
    sampleRate: z.literal(24000), segmentFrames: z.number().int().positive().safe().optional(), final: z.boolean() }),
  VoiceOutputHandleSchema.extend({ type: z.literal('finished') }),
  VoiceOutputHandleSchema.extend({ type: z.literal('cancelled') }),
  VoiceOutputHandleSchema.extend({ type: z.literal('failed') })
]);
export type VoiceOutputFrame = z.infer<typeof VoiceOutputFrameSchema>;
export const VoiceOutputAckSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('started'), generation: z.number().int().nonnegative().safe(), segmentId: Id }).strict(),
  z.object({ type: z.literal('consumed'), generation: z.number().int().nonnegative().safe(), sequence: z.number().int().positive().safe(), bufferedMs: z.number().min(0).max(60_000) }).strict(),
  z.object({ type: z.literal('played'), generation: z.number().int().nonnegative().safe(), segmentId: Id }).strict(),
  z.object({ type: z.literal('cancel'), generation: z.number().int().nonnegative().safe() }).strict()
]);
export type VoiceOutputAck = z.infer<typeof VoiceOutputAckSchema>;
export const VoiceOutputAttachSchema = z.object({ type: z.literal('voice.output.attach'), handle: VoiceOutputHandleSchema }).strict();
