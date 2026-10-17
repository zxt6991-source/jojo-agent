import { z } from 'zod';

const Id = z.string().min(1).max(256);
export const SchedulePlaybackIdentitySchema = z.object({
  itemId: Id, claimToken: Id, playbackId: Id, generation: z.number().int().nonnegative().safe()
}).strict();
export type SchedulePlaybackIdentity = z.infer<typeof SchedulePlaybackIdentitySchema>;

export const ScheduleDesktopDeliverySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('voice'), identity: SchedulePlaybackIdentitySchema,
    scheduleId: Id, scheduleRunId: Id, assetId: z.string().uuid(), expiresAt: z.string().datetime() }).strict(),
  z.object({ kind: z.literal('notification'), identity: SchedulePlaybackIdentitySchema,
    scheduleId: Id, scheduleRunId: Id, title: z.string().min(1).max(256), expiresAt: z.string().datetime().optional() }).strict()
]);
export type ScheduleDesktopDelivery = z.infer<typeof ScheduleDesktopDeliverySchema>;
export const ScheduleDesktopOutcomeSchema = z.object({
  identity: SchedulePlaybackIdentitySchema,
  state: z.enum(['delivered', 'played', 'failed', 'suppressed', 'interrupted', 'uncertain']),
  errorCode: z.string().max(256).optional()
}).strict();
export type ScheduleDesktopOutcome = z.infer<typeof ScheduleDesktopOutcomeSchema>;
export const ScheduleDeliveryControlSchema = z.object({
  action: z.enum(['start', 'renew']), identity: SchedulePlaybackIdentitySchema
}).strict();
export type ScheduleDeliveryControl = z.infer<typeof ScheduleDeliveryControlSchema>;
export const ReplayScheduleDeliveryInputSchema = z.object({ itemId: Id }).strict();

export const ScheduleVoicePreparationSchema = z.object({
  scheduleId: Id, revision: z.number().int().nonnegative(),
  state: z.enum(['not_prepared', 'preparing', 'ready', 'failed', 'unavailable', 'dynamic']),
  updatedAt: z.string().datetime(), reason: z.string().max(256).optional()
}).strict();
export type ScheduleVoicePreparation = z.infer<typeof ScheduleVoicePreparationSchema>;
export const PreviewScheduleVoiceInputSchema = z.object({
  scheduleId: Id, generation: z.number().int().nonnegative().safe()
}).strict();
export type PreviewScheduleVoiceInput = z.infer<typeof PreviewScheduleVoiceInputSchema>;
