import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ChannelDeliveryError,
  type ChannelActionButton,
  type ChannelAdapter,
  type ChannelAdapterContext,
  type ChannelCapabilities,
  type ChannelContentBlock,
  type ChannelEditRequest,
  type ChannelInboundEvent,
  type ChannelInstance,
  type ChannelMediaSource,
  type ChannelSendReceipt,
  type ChannelSendRequest,
  type ChannelValidationResult,
  type ChannelWebhookRequest,
  type ChannelWebhookResponse
} from '@desktop-agent/channel-core';
import { parseFeishuConfig, type FeishuAdapterConfig } from './config.js';
import { decryptFeishuPayload, safeEqual, verifyFeishuSignature } from './crypto.js';
import type { FeishuCardActionEvent, FeishuEnvelope, FeishuMessageEvent, FeishuTokenResponse } from './types.js';

export const FEISHU_CAPABILITIES: ChannelCapabilities = {
  inbound: { text: true, markdown: false, image: true, file: true, voice: false, video: false, interaction: true, thread: true },
  outbound: { text: true, markdown: true, image: true, file: true, buttons: true, edit: true, typing: false, thread: false },
  limits: { maxTextChars: 150 * 1024, maxFileBytes: 30 * 1024 * 1024, maxButtons: 20 },
  transport: 'webhook'
};

export type FeishuAdapterOptions = {
  instance: ChannelInstance;
  appSecret: string;
  verificationToken: string;
  encryptKey?: string;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  now?: () => Date;
};

export class FeishuChannelAdapter implements ChannelAdapter {
  readonly kind = 'feishu' as const;
  readonly instanceId: string;
  readonly capabilities = FEISHU_CAPABILITIES;
  private readonly config: FeishuAdapterConfig;
  private readonly fetch: typeof fetch;
  private readonly apiBaseUrl: string;
  private readonly now: () => Date;
  private context: ChannelAdapterContext | undefined;
  private accessToken: { value: string; expiresAt: number } | undefined;
  private tokenRequest: Promise<string> | undefined;

  constructor(private readonly options: FeishuAdapterOptions) {
    this.instanceId = options.instance.id;
    this.config = parseFeishuConfig(options.instance);
    this.fetch = options.fetch ?? globalThis.fetch;
    this.apiBaseUrl = (options.apiBaseUrl ?? 'https://open.feishu.cn').replace(/\/$/u, '');
    this.now = options.now ?? (() => new Date());
  }

  async validateConfig(): Promise<ChannelValidationResult> {
    const errors: string[] = [];
    if (!this.options.appSecret.trim()) errors.push('appSecret secret is empty');
    if (!this.options.verificationToken.trim()) errors.push('verificationToken secret is empty');
    if (!this.options.instance.secretRefs.appSecret) errors.push('secretRefs.appSecret is required');
    if (!this.options.instance.secretRefs.verificationToken) errors.push('secretRefs.verificationToken is required');
    if (this.options.instance.secretRefs.encryptKey && !this.options.encryptKey?.trim()) errors.push('encryptKey secret is empty');
    return errors.length ? { valid: false, errors } : { valid: true };
  }

  async start(context: ChannelAdapterContext): Promise<void> {
    const validation = await this.validateConfig();
    if (!validation.valid) throw new Error(`feishu_invalid_config: ${validation.errors.join('; ')}`);
    this.context = context;
  }

  async stop(): Promise<void> {
    this.context = undefined;
    this.accessToken = undefined;
    this.tokenRequest = undefined;
  }

  async handleWebhook(request: ChannelWebhookRequest): Promise<ChannelWebhookResponse> {
    if (request.method.toUpperCase() !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } };
    let payload: Record<string, unknown>;
    try {
      payload = this.parseAndVerifyWebhook(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'feishu_invalid_webhook';
      return { status: message === 'feishu_invalid_signature' || message === 'feishu_invalid_verification_token' ? 401 : 400, body: { error: message } };
    }

    if (payload.type === 'url_verification' && typeof payload.challenge === 'string') {
      return { status: 200, body: { challenge: payload.challenge } };
    }

    const eventType = object(payload.header).event_type;
    if (eventType !== 'im.message.receive_v1' && eventType !== 'card.action.trigger') {
      return { status: 200, body: {} };
    }
    void this.normalize(payload, eventType).then((event) => {
      if (!event || !this.context) return;
      return this.context.emit(event);
    }).catch(() => undefined);
    return eventType === 'card.action.trigger'
      ? { status: 200, body: { toast: { type: 'info', content: '请求已收到' } } }
      : { status: 200, body: {} };
  }

  async send(request: ChannelSendRequest): Promise<ChannelSendReceipt> {
    const textBlocks = request.content.filter((block): block is Extract<ChannelContentBlock, { type: 'text' | 'markdown' }> =>
      block.type === 'text' || block.type === 'markdown');
    const media = request.content.filter((block): block is Extract<ChannelContentBlock, { type: 'image' | 'file' }> =>
      block.type === 'image' || block.type === 'file');
    const actions = request.content.flatMap((block) => block.type === 'actions' ? block.buttons : []);
    const markdown = textBlocks.some((block) => block.type === 'markdown');
    validateActions(actions);
    const text = textBlocks.map((block) => block.text).join('\n\n');
    let nativeMessageId: string | undefined;

    for (const [index, block] of media.entries()) {
      const key = block.type === 'image'
        ? await this.uploadImage(block.source)
        : await this.uploadFile(block.source, block.name, block.mimeType);
      const receipt = await this.createMessage(request, block.type, block.type === 'image' ? { image_key: key } : { file_key: key }, `${index}`);
      nativeMessageId ??= receipt;
    }

    if (text || actions.length || !media.length) {
      const message = markdown || actions.length
        ? { type: 'interactive', content: card(text || '请选择操作：', actions) }
        : { type: 'text', content: { text } };
      nativeMessageId ??= await this.createMessage(request, message.type, message.content, 'content');
    }
    if (!nativeMessageId) throw new ChannelDeliveryError('feishu_empty_message', 'permanent');
    return { requestId: request.id, nativeMessageId, deliveredAt: this.now().toISOString() };
  }

  async edit(request: ChannelEditRequest): Promise<ChannelSendReceipt> {
    const text = request.content.flatMap((block) => block.type === 'text' || block.type === 'markdown' ? [block.text] : []).join('\n\n');
    const actions = request.content.flatMap((block) => block.type === 'actions' ? block.buttons : []);
    validateActions(actions);
    if (!text && !actions.length) throw new ChannelDeliveryError('feishu_edit_content_required', 'permanent');
    const message = actions.length
      ? { msg_type: 'interactive', content: JSON.stringify(card(text || '请选择操作：', actions)) }
      : { msg_type: 'text', content: JSON.stringify({ text }) };
    await this.api(`/open-apis/im/v1/messages/${encodeURIComponent(request.nativeMessageId)}`, {
      method: 'PATCH', body: JSON.stringify(message)
    }, true);
    return { requestId: request.id, nativeMessageId: request.nativeMessageId, deliveredAt: this.now().toISOString() };
  }

  private parseAndVerifyWebhook(request: ChannelWebhookRequest): Record<string, unknown> {
    const raw = request.rawBody ?? (typeof request.body === 'string' ? request.body : undefined);
    if (this.options.encryptKey) {
      if (raw === undefined) throw new Error('feishu_raw_body_required');
      const timestamp = header(request, 'x-lark-request-timestamp');
      const nonce = header(request, 'x-lark-request-nonce');
      const signature = header(request, 'x-lark-signature');
      if (!timestamp || !nonce || !signature || !verifyFeishuSignature(raw, timestamp, nonce, this.options.encryptKey, signature)) {
        throw new Error('feishu_invalid_signature');
      }
    }
    let payload = parseObject(request.body ?? raw);
    if (typeof payload.encrypt === 'string') {
      if (!this.options.encryptKey) throw new Error('feishu_encrypt_key_required');
      payload = parseObject(decryptFeishuPayload(payload.encrypt, this.options.encryptKey));
    }
    const token = typeof payload.token === 'string' ? payload.token : object(payload.header).token;
    if (typeof token !== 'string' || !safeEqual(token, this.options.verificationToken)) {
      throw new Error('feishu_invalid_verification_token');
    }
    return payload;
  }

  private async normalize(payload: Record<string, unknown>, eventType: string): Promise<ChannelInboundEvent | undefined> {
    if (eventType === 'card.action.trigger') return this.normalizeAction(payload as FeishuCardActionEvent);
    return this.normalizeMessage(payload as FeishuMessageEvent);
  }

  private async normalizeMessage(payload: FeishuMessageEvent): Promise<ChannelInboundEvent | undefined> {
    const message = payload.event?.message;
    const messageId = message?.message_id;
    const chatId = message?.chat_id;
    if (!messageId || !chatId) return undefined;
    const parsed = parseContent(message.content);
    const text = typeof parsed.text === 'string' ? parsed.text : undefined;
    const content: ChannelContentBlock[] = [];
    if (message.message_type === 'image' && typeof parsed.image_key === 'string') {
      content.push({ type: 'image', source: await this.downloadResource(messageId, parsed.image_key, 'image', 'image', this.config.maxImageBytes) });
    } else if (message.message_type === 'file' && typeof parsed.file_key === 'string') {
      const name = safeFilename(typeof parsed.file_name === 'string' ? parsed.file_name : 'attachment', 'attachment');
      content.push({ type: 'file', source: await this.downloadResource(messageId, parsed.file_key, 'file', name, this.config.maxFileBytes), name });
    }
    const senderId = identity(payload.event?.sender?.sender_id);
    const mentions = message.mentions?.flatMap((mention) => {
      const id = identity(mention.id);
      return id ? [{ id, ...(mention.name ? { displayName: mention.name } : {}) }] : [];
    });
    return {
      id: `feishu_${this.instanceId}_${safeId(messageId)}`,
      kind: 'message', channel: { kind: 'feishu', instanceId: this.instanceId },
      conversation: {
        id: chatId, type: message.chat_type === 'p2p' ? 'direct' : 'group',
        ...(message.thread_id ? { threadId: message.thread_id } : {})
      },
      sender: { id: senderId ?? 'unknown', ...(payload.event?.sender?.sender_type === 'app' ? { isBot: true } : {}) },
      message: {
        id: messageId, ...(text ? { text } : {}), ...(content.length ? { content } : {}),
        ...(message.parent_id ? { replyTo: message.parent_id } : {}), ...(mentions?.length ? { mentions } : {})
      },
      receivedAt: eventTime(payload.header?.create_time, this.now()), dedupeKey: `message:${messageId}`,
      security: { verified: true, verificationMethod: 'webhook_signature' }
    };
  }

  private normalizeAction(payload: FeishuCardActionEvent): ChannelInboundEvent | undefined {
    const event = payload.event;
    const actionToken = extractActionToken(event?.action?.value);
    const chatId = event?.context?.open_chat_id;
    if (!actionToken || !chatId) return undefined;
    const eventId = payload.header?.event_id ?? `${event.context?.open_message_id ?? 'card'}_${createHash('sha256').update(actionToken).digest('hex').slice(0, 12)}`;
    return {
      id: `feishu_${this.instanceId}_${safeId(eventId)}`, kind: 'interaction',
      channel: { kind: 'feishu', instanceId: this.instanceId }, conversation: { id: chatId, type: 'group' },
      sender: { id: identity(event.operator) ?? 'unknown' }, interaction: { actionToken },
      receivedAt: eventTime(payload.header?.create_time, this.now()), dedupeKey: `event:${eventId}`,
      security: { verified: true, verificationMethod: 'webhook_signature' }
    };
  }

  private async downloadResource(messageId: string, key: string, type: 'image' | 'file', name: string, maximum: number): Promise<ChannelMediaSource> {
    const response = await this.api(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(key)}?type=${type}`, {}, false, false);
    const size = Number(response.headers.get('content-length'));
    if (Number.isFinite(size) && size > maximum) throw new Error('feishu_attachment_too_large');
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength > maximum) throw new Error('feishu_attachment_too_large');
    const directory = path.join(this.config.cacheDirectory, `feishu_${safeId(messageId)}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const filename = `${createHash('sha256').update(key).digest('hex').slice(0, 12)}-${safeFilename(name, type)}`;
    const localPath = path.join(directory, filename);
    await writeFile(localPath, data, { mode: 0o600 });
    return { kind: 'local_file', path: localPath };
  }

  private async uploadImage(source: ChannelMediaSource): Promise<string> {
    const form = new FormData();
    form.set('image_type', 'message');
    form.set('image', await mediaBlob(source), 'image');
    const envelope = await this.apiJson<{ image_key?: string }>('/open-apis/im/v1/images', { method: 'POST', body: form }, true);
    if (!envelope.image_key) throw new ChannelDeliveryError('feishu_image_key_missing', 'unknown');
    return envelope.image_key;
  }

  private async uploadFile(source: ChannelMediaSource, name: string, mimeType?: string): Promise<string> {
    const form = new FormData();
    form.set('file_type', feishuFileType(name, mimeType));
    form.set('file_name', safeFilename(name, 'attachment'));
    form.set('file', await mediaBlob(source), safeFilename(name, 'attachment'));
    const envelope = await this.apiJson<{ file_key?: string }>('/open-apis/im/v1/files', { method: 'POST', body: form }, true);
    if (!envelope.file_key) throw new ChannelDeliveryError('feishu_file_key_missing', 'unknown');
    return envelope.file_key;
  }

  private async createMessage(request: ChannelSendRequest, msgType: string, content: unknown, suffix: string): Promise<string> {
    const body = { msg_type: msgType, content: JSON.stringify(content), uuid: uuid(`${request.id}:${suffix}`) };
    const endpoint = request.replyTo
      ? `/open-apis/im/v1/messages/${encodeURIComponent(request.replyTo)}/reply`
      : `/open-apis/im/v1/messages?receive_id_type=chat_id`;
    const data = await this.apiJson<{ message_id?: string }>(endpoint, {
      method: 'POST', body: JSON.stringify(request.replyTo ? body : { receive_id: request.target.conversationId, ...body })
    }, true);
    if (!data.message_id) throw new ChannelDeliveryError('feishu_message_id_missing', 'unknown');
    return data.message_id;
  }

  private async apiJson<T>(endpoint: string, init: RequestInit, outbound: boolean): Promise<T> {
    const response = await this.api(endpoint, init, outbound, true);
    let envelope: FeishuEnvelope<T>;
    try { envelope = await response.json() as FeishuEnvelope<T>; }
    catch { throw outbound ? new ChannelDeliveryError('feishu_invalid_response', 'unknown') : new Error('feishu_invalid_response'); }
    if (envelope.code !== 0 || !envelope.data) {
      const message = `feishu_api_failed: ${envelope.code} ${envelope.msg ?? ''}`.trim();
      throw outbound ? new ChannelDeliveryError(message, response.status === 429 || response.status >= 500 ? 'retryable' : 'permanent') : new Error(message);
    }
    return envelope.data;
  }

  private async api(endpoint: string, init: RequestInit, outbound: boolean, json = false): Promise<Response> {
    const token = await this.tenantAccessToken();
    let response: Response;
    try {
      const headers = new Headers(init.headers);
      headers.set('authorization', `Bearer ${token}`);
      if (json && typeof init.body === 'string') headers.set('content-type', 'application/json');
      response = await this.fetch(`${this.apiBaseUrl}${endpoint}`, { ...init, headers });
    } catch (error) {
      if (outbound) throw new ChannelDeliveryError('feishu_delivery_outcome_unknown', 'unknown', { cause: error });
      throw new Error('feishu_transport_failed', { cause: error });
    }
    if (!response.ok) {
      const message = `feishu_http_failed: ${response.status}`;
      if (outbound) throw new ChannelDeliveryError(message, response.status === 429 || response.status >= 500 ? 'retryable' : 'permanent');
      throw new Error(message);
    }
    return response;
  }

  private async tenantAccessToken(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 60_000) return this.accessToken.value;
    if (this.tokenRequest) return this.tokenRequest;
    this.tokenRequest = (async () => {
      let response: Response;
      try {
        response = await this.fetch(`${this.apiBaseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ app_id: this.config.appId, app_secret: this.options.appSecret })
        });
      } catch (error) { throw new ChannelDeliveryError('feishu_auth_transport_failed', 'retryable', { cause: error }); }
      let result: FeishuTokenResponse;
      try { result = await response.json() as FeishuTokenResponse; }
      catch { throw new ChannelDeliveryError('feishu_auth_invalid_response', 'retryable'); }
      if (!response.ok || result.code !== 0 || !result.tenant_access_token) {
        throw new ChannelDeliveryError(`feishu_auth_failed: ${result.code ?? response.status}`, response.status >= 500 ? 'retryable' : 'permanent');
      }
      this.accessToken = { value: result.tenant_access_token, expiresAt: Date.now() + Math.max(60, result.expire ?? 7_200) * 1_000 };
      return result.tenant_access_token;
    })().finally(() => { this.tokenRequest = undefined; });
    return this.tokenRequest;
  }
}

function header(request: ChannelWebhookRequest, name: string): string | undefined {
  const match = Object.entries(request.headers).find(([key]) => key.toLowerCase() === name);
  return match?.[1];
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'string' || value instanceof Uint8Array) {
    try { value = JSON.parse(typeof value === 'string' ? value : Buffer.from(value).toString('utf8')); }
    catch { throw new Error('feishu_invalid_json'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('feishu_invalid_json');
  return value as Record<string, unknown>;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseContent(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try { return object(JSON.parse(value)); }
  catch { return {}; }
}

function identity(value: { open_id?: string; user_id?: string; union_id?: string } | undefined): string | undefined {
  return value?.open_id ?? value?.user_id ?? value?.union_id;
}

function extractActionToken(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  const record = object(value);
  return typeof record.actionToken === 'string' ? record.actionToken
    : typeof record.action_token === 'string' ? record.action_token
      : undefined;
}

function card(text: string, actions: ChannelActionButton[]): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    elements: [
      { tag: 'markdown', content: text },
      ...(actions.length ? [{ tag: 'action', actions: actions.map((button) => ({
        tag: 'button', text: { tag: 'plain_text', content: button.label },
        type: button.style === 'danger' ? 'danger' : button.style === 'primary' ? 'primary' : 'default',
        value: { actionToken: button.actionToken }
      })) }] : [])
    ]
  };
}

function validateActions(actions: ChannelActionButton[]): void {
  if (actions.length > (FEISHU_CAPABILITIES.limits.maxButtons ?? 20)) throw new ChannelDeliveryError('feishu_too_many_buttons', 'permanent');
  if (actions.some((button) => Buffer.byteLength(button.actionToken, 'utf8') > 2_048)) {
    throw new ChannelDeliveryError('feishu_action_token_too_long', 'permanent');
  }
}

function uuid(value: string): string {
  return value.length <= 50 ? value : createHash('sha256').update(value).digest('hex').slice(0, 50);
}

function eventTime(value: string | undefined, fallback: Date): string {
  if (!value) return fallback.toISOString();
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds)) return fallback.toISOString();
  const date = new Date(value.length <= 10 ? milliseconds * 1_000 : milliseconds);
  return Number.isNaN(date.getTime()) ? fallback.toISOString() : date.toISOString();
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, '_').slice(0, 160) || 'unknown';
}

function safeFilename(value: string, fallback: string): string {
  const base = path.basename(value).replace(/\p{Cc}/gu, '').replace(/[^\p{L}\p{N}._ -]/gu, '_').trim();
  return base && base !== '.' && base !== '..' ? base.slice(0, 180) : fallback;
}

function feishuFileType(name: string, mimeType?: string): string {
  const extension = path.extname(name).toLowerCase();
  if (mimeType?.startsWith('audio/') || ['.mp3', '.wav', '.opus'].includes(extension)) return 'opus';
  if (mimeType?.startsWith('video/') || extension === '.mp4') return 'mp4';
  if (extension === '.pdf') return 'pdf';
  if (['.doc', '.docx'].includes(extension)) return 'doc';
  if (['.xls', '.xlsx'].includes(extension)) return 'xls';
  if (['.ppt', '.pptx'].includes(extension)) return 'ppt';
  return 'stream';
}

async function mediaBlob(source: ChannelMediaSource): Promise<Blob> {
  if (source.kind === 'buffer') return new Blob([source.data as BlobPart], { type: source.mimeType });
  return new Blob([await readFile(source.path)]);
}
