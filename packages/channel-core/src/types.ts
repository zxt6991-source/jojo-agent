export type ChannelKind =
  | 'telegram'
  | 'feishu'
  | 'wecom'
  | 'dingtalk'
  | 'discord'
  | (string & {});

export type ChannelInstanceId = string;

export type ChannelCapabilities = {
  inbound: {
    text: boolean;
    markdown: boolean;
    image: boolean;
    file: boolean;
    voice: boolean;
    video: boolean;
    interaction: boolean;
    thread: boolean;
  };
  outbound: {
    text: boolean;
    markdown: boolean;
    image: boolean;
    file: boolean;
    buttons: boolean;
    edit: boolean;
    typing: boolean;
    thread: boolean;
  };
  limits: {
    maxTextChars?: number;
    maxFileBytes?: number;
    maxButtons?: number;
  };
  transport: 'polling' | 'gateway' | 'webhook' | 'local';
};

export type ChannelMediaSource =
  | { kind: 'local_file'; path: string }
  | { kind: 'buffer'; mimeType: string; data: Uint8Array };

export type ChannelActionButton = {
  label: string;
  actionToken: string;
  style?: 'default' | 'primary' | 'danger';
};

export type ChannelContentBlock =
  | { type: 'text'; text: string }
  | { type: 'markdown'; text: string }
  | { type: 'image'; source: ChannelMediaSource; alt?: string }
  | { type: 'file'; source: ChannelMediaSource; name: string; mimeType?: string }
  | { type: 'actions'; buttons: ChannelActionButton[] };

export type ChannelAddress = {
  instanceId: ChannelInstanceId;
  conversationId: string;
  threadId?: string;
};

export type ChannelCorrelation = {
  sessionId?: string;
  runId?: string;
  scheduleId?: string;
  scheduleRunId?: string;
  approvalId?: string;
};

export type ChannelSendRequest = {
  id: string;
  target: ChannelAddress;
  content: ChannelContentBlock[];
  replyTo?: string;
  correlation?: ChannelCorrelation;
  mode?: 'reply' | 'proactive' | 'system';
};

export type ChannelSendReceipt = {
  requestId: string;
  nativeMessageId?: string;
  deliveredAt: string;
};

export type ChannelEditRequest = ChannelSendRequest & { nativeMessageId: string };

export type ChannelTypingRequest = {
  target: ChannelAddress;
  active: boolean;
};

export type ChannelInboundEvent = {
  id: string;
  kind: 'message' | 'interaction' | 'reaction' | 'system';
  channel: { kind: ChannelKind; instanceId: ChannelInstanceId };
  conversation: { id: string; type: 'direct' | 'group'; threadId?: string };
  sender: { id: string; displayName?: string; isBot?: boolean };
  message?: {
    id: string;
    text?: string;
    content?: ChannelContentBlock[];
    replyTo?: string;
    mentions?: Array<{ id: string; displayName?: string }>;
  };
  interaction?: { actionToken: string; value?: string };
  receivedAt: string;
  dedupeKey: string;
  security: {
    verified: boolean;
    verificationMethod: 'webhook_signature' | 'trusted_gateway' | 'polling_api' | 'local';
  };
};

export type ChannelValidationResult =
  | { valid: true }
  | { valid: false; errors: string[] };

export type ChannelWebhookRequest = {
  method: string;
  headers: Record<string, string | undefined>;
  /** Exact bytes received from the transport. Required by signed webhook adapters. */
  rawBody?: string | Uint8Array;
  body?: unknown;
};

export type ChannelWebhookResponse = {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
};

export type ChannelInstance = {
  id: string;
  kind: ChannelKind;
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  secretRefs: Record<string, string>;
  revision: number;
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
};

export type ChannelBinding = {
  id: string;
  instanceId: string;
  conversation: { id: string; threadId?: string; type: 'direct' | 'group' };
  routing: {
    sessionMode: 'persistent' | 'per_thread' | 'stateless';
    sessionId?: string;
    workspaceRoot?: string;
    providerId?: string;
    model?: string;
    instructions?: string[];
    profile?: string;
  };
  policy: {
    enabled: boolean;
    requireMention: boolean;
    queueMode: 'queue' | 'reject' | 'interrupt';
    allowedSenders?: string[];
    allowAttachments: boolean;
  };
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type ChannelPrincipal = {
  id: string;
  type: 'channel_user';
  channelKind: string;
  instanceId: string;
  externalUserId: string;
  conversationId: string;
  trusted: boolean;
};

export type ChannelPairing = {
  id: string;
  instanceId: string;
  conversationId: string;
  senderId: string;
  codeHash: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  expiresAt: string;
  createdAt: string;
  resolvedAt?: string;
};

export type ChannelActionToken = {
  tokenHash: string;
  actionType: 'approval';
  payload: { approvalId: string; decision: 'allow' | 'deny' };
  allowedSenderId?: string;
  expiresAt: string;
  createdAt: string;
  usedAt?: string;
};

export type ChannelOutboxItem = {
  id: string;
  instanceId: string;
  bindingId?: string;
  conversationId: string;
  threadId?: string;
  request: ChannelSendRequest;
  idempotencyKey: string;
  status: 'pending' | 'sending' | 'delivered' | 'failed' | 'unknown';
  attemptCount: number;
  nextAttemptAt?: string;
  createdAt: string;
  deliveredAt?: string;
  nativeMessageId?: string;
  lastError?: string;
};

export type ChannelDeliveryInput = {
  bindingId?: string;
  target?: ChannelAddress;
  content: ChannelContentBlock[];
  replyTo?: string;
  correlation?: ChannelCorrelation;
  mode: 'reply' | 'proactive' | 'system';
  idempotencyKey?: string;
};

export type ChannelDeliveryReceipt = {
  deliveryId: string;
  status: ChannelOutboxItem['status'];
  nativeMessageId?: string;
};

export type ChannelInstanceHealth = {
  status: 'starting' | 'connected' | 'degraded' | 'stopped' | 'failed';
  lastInboundAt?: string;
  lastOutboundAt?: string;
  lastError?: string;
  reconnectCount: number;
};

export type ChannelRuntimeEvent =
  | { type: 'channel.instance.status'; instanceId: string; status: ChannelInstanceHealth['status']; error?: string }
  | { type: 'channel.inbound.received'; eventId: string; instanceId: string }
  | { type: 'channel.inbound.rejected'; eventId: string; instanceId: string; reason: string }
  | { type: 'channel.run.started'; eventId: string; sessionId: string; runId: string }
  | { type: 'channel.delivery.changed'; deliveryId: string; status: ChannelOutboxItem['status'] }
  | { type: 'channel.pairing.created'; pairingId: string; code: string };
