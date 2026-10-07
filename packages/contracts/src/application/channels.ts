import { z } from 'zod';
import { JsonValueSchema } from '../execution-scope.js';

export const ChannelInstanceSchema = z.object({
  id: z.string().min(1).max(256),
  kind: z.string().min(1).max(64),
  name: z.string().min(1).max(256),
  enabled: z.boolean(),
  config: z.record(z.string(), JsonValueSchema),
  secretRefs: z.record(z.string().min(1).max(128), z.string().min(1).max(2_048)),
  revision: z.number().int().positive(),
  fingerprint: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();
export type ChannelInstanceDto = z.infer<typeof ChannelInstanceSchema>;

export const CreateChannelInstanceInputSchema = z.object({
  id: z.string().min(1).max(256).optional(),
  kind: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(256),
  enabled: z.boolean().default(true),
  config: z.record(z.string(), JsonValueSchema).default({}),
  secretRefs: z.record(z.string().min(1).max(128), z.string().min(1).max(2_048)).default({})
}).strict();
export type CreateChannelInstanceInput = z.infer<typeof CreateChannelInstanceInputSchema>;

export const UpdateChannelInstanceInputSchema = z.object({
  name: z.string().trim().min(1).max(256).optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.string(), JsonValueSchema).optional(),
  secretRefs: z.record(z.string().min(1).max(128), z.string().min(1).max(2_048)).optional(),
  expectedRevision: z.number().int().positive().optional()
}).strict();
export type UpdateChannelInstanceInput = z.infer<typeof UpdateChannelInstanceInputSchema>;

export const ChannelConversationSchema = z.object({
  id: z.string().min(1).max(512),
  threadId: z.string().min(1).max(512).optional(),
  type: z.enum(['direct', 'group'])
}).strict();

export const ChannelRoutingSchema = z.object({
  sessionMode: z.enum(['persistent', 'per_thread', 'stateless']),
  sessionId: z.string().min(1).max(256).optional(),
  workspaceRoot: z.string().min(1).max(4_096).optional(),
  providerId: z.string().min(1).max(256).optional(),
  model: z.string().min(1).max(256).optional(),
  instructions: z.array(z.string().max(20_000)).max(20).optional(),
  profile: z.string().min(1).max(256).optional()
}).strict();

export const ChannelBindingPolicySchema = z.object({
  enabled: z.boolean(),
  requireMention: z.boolean(),
  queueMode: z.enum(['queue', 'reject', 'interrupt']),
  allowedSenders: z.array(z.string().min(1).max(512)).max(1_000).optional(),
  allowAttachments: z.boolean()
}).strict();

export const ChannelBindingSchema = z.object({
  id: z.string().min(1).max(256),
  instanceId: z.string().min(1).max(256),
  conversation: ChannelConversationSchema,
  routing: ChannelRoutingSchema,
  policy: ChannelBindingPolicySchema,
  revision: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();
export type ChannelBindingDto = z.infer<typeof ChannelBindingSchema>;

export const CreateChannelBindingInputSchema = z.object({
  id: z.string().min(1).max(256).optional(),
  instanceId: z.string().min(1).max(256),
  conversation: ChannelConversationSchema,
  routing: ChannelRoutingSchema,
  policy: ChannelBindingPolicySchema
}).strict();
export type CreateChannelBindingInput = z.infer<typeof CreateChannelBindingInputSchema>;

export const UpdateChannelBindingInputSchema = z.object({
  routing: ChannelRoutingSchema.optional(),
  policy: ChannelBindingPolicySchema.optional(),
  expectedRevision: z.number().int().positive().optional()
}).strict();
export type UpdateChannelBindingInput = z.infer<typeof UpdateChannelBindingInputSchema>;

export const ChannelPairingSchema = z.object({
  id: z.string().min(1),
  instanceId: z.string().min(1),
  conversationId: z.string().min(1),
  senderId: z.string().min(1),
  status: z.enum(['pending', 'approved', 'rejected', 'expired']),
  expiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  resolvedAt: z.string().datetime().optional()
}).strict();
export type ChannelPairingDto = z.infer<typeof ChannelPairingSchema>;

export const ChannelPairingListQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'expired']).optional()
}).strict();

export const ApproveChannelPairingInputSchema = z.object({ binding: CreateChannelBindingInputSchema }).strict();
export type ApproveChannelPairingInput = z.infer<typeof ApproveChannelPairingInputSchema>;

export const ChannelDeliveryStatusSchema = z.enum(['pending', 'sending', 'delivered', 'failed', 'unknown']);
export const ChannelDeliverySchema = z.object({
  id: z.string().min(1),
  instanceId: z.string().min(1),
  bindingId: z.string().min(1).optional(),
  conversationId: z.string().min(1),
  threadId: z.string().min(1).optional(),
  mode: z.enum(['reply', 'proactive', 'system']).optional(),
  status: ChannelDeliveryStatusSchema,
  attemptCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  deliveredAt: z.string().datetime().optional(),
  nativeMessageId: z.string().optional(),
  lastError: z.string().optional()
}).strict();
export type ChannelDeliveryDto = z.infer<typeof ChannelDeliverySchema>;

export const ChannelDeliveryReceiptSchema = z.object({
  deliveryId: z.string().min(1),
  status: ChannelDeliveryStatusSchema,
  nativeMessageId: z.string().optional()
}).strict();
export type ChannelDeliveryReceiptDto = z.infer<typeof ChannelDeliveryReceiptSchema>;

export const ChannelDeliveryListQuerySchema = z.object({
  instanceId: z.string().min(1).optional(),
  status: ChannelDeliveryStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100)
}).strict();
export type ChannelDeliveryListQuery = z.infer<typeof ChannelDeliveryListQuerySchema>;

export const ChannelHealthSchema = z.object({
  instanceId: z.string().min(1),
  status: z.enum(['starting', 'connected', 'degraded', 'stopped', 'failed']),
  lastInboundAt: z.string().datetime().optional(),
  lastOutboundAt: z.string().datetime().optional(),
  lastError: z.string().optional(),
  reconnectCount: z.number().int().nonnegative()
}).strict();
export type ChannelHealthDto = z.infer<typeof ChannelHealthSchema>;

export const TestChannelInputSchema = z.object({
  bindingId: z.string().min(1).max(256).optional(),
  conversationId: z.string().min(1).max(512).optional(),
  threadId: z.string().min(1).max(512).optional(),
  text: z.string().min(1).max(100_000).default('Jojo 通道连接测试成功。')
}).strict().refine((value) => Boolean(value.bindingId) !== Boolean(value.conversationId), {
  message: 'Exactly one of bindingId or conversationId is required.'
});
export type TestChannelInput = z.infer<typeof TestChannelInputSchema>;

