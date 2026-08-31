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
  type ChannelTypingRequest,
  type ChannelValidationResult
} from '@desktop-agent/channel-core';
import { parseTelegramConfig, type TelegramAdapterConfig } from './config.js';
import { safeTelegramFilename, telegramMarkdownHtml } from './format.js';
import type {
  TelegramCallbackQuery,
  TelegramFile,
  TelegramMessage,
  TelegramResponse,
  TelegramUpdate,
  TelegramUser
} from './types.js';

export const TELEGRAM_CAPABILITIES: ChannelCapabilities = {
  inbound: { text: true, markdown: false, image: true, file: true, voice: false, video: false, interaction: true, thread: true },
  outbound: { text: true, markdown: true, image: true, file: true, buttons: true, edit: true, typing: true, thread: true },
  limits: { maxTextChars: 4_096, maxFileBytes: 50 * 1024 * 1024, maxButtons: 8 },
  transport: 'polling'
};

export type TelegramAdapterOptions = {
  instance: ChannelInstance;
  botToken: string;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  random?: () => number;
};

export class TelegramChannelAdapter implements ChannelAdapter {
  readonly kind = 'telegram' as const;
  readonly instanceId: string;
  readonly capabilities = TELEGRAM_CAPABILITIES;
  private readonly config: TelegramAdapterConfig;
  private readonly fetch: typeof fetch;
  private readonly apiBaseUrl: string;
  private readonly now: () => Date;
  private readonly random: () => number;
  private context: ChannelAdapterContext | undefined;
  private controller: AbortController | undefined;
  private polling: Promise<void> | undefined;
  private offset = 0;

  constructor(private readonly options: TelegramAdapterOptions) {
    this.instanceId = options.instance.id;
    this.config = parseTelegramConfig(options.instance);
    this.fetch = options.fetch ?? globalThis.fetch;
    this.apiBaseUrl = (options.apiBaseUrl ?? 'https://api.telegram.org').replace(/\/$/u, '');
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
  }

  async validateConfig(): Promise<ChannelValidationResult> {
    const errors: string[] = [];
    if (!this.options.botToken.trim()) errors.push('botToken secret is empty');
    if (!this.options.instance.secretRefs.botToken) errors.push('secretRefs.botToken is required');
    return errors.length ? { valid: false, errors } : { valid: true };
  }

  async start(context: ChannelAdapterContext): Promise<void> {
    if (this.polling) return;
    const validation = await this.validateConfig();
    if (!validation.valid) throw new Error(`telegram_invalid_config: ${validation.errors.join('; ')}`);
    this.context = context;
    this.controller = new AbortController();
    await this.call<TelegramUser>('getMe', {}, context.signal, false);
    const signal = AbortSignal.any([context.signal, this.controller.signal]);
    this.polling = this.poll(signal).finally(() => { this.polling = undefined; });
  }

  async stop(): Promise<void> {
    this.controller?.abort('telegram_adapter_stopped');
    await this.polling;
    this.context = undefined;
    this.controller = undefined;
  }

  async send(request: ChannelSendRequest): Promise<ChannelSendReceipt> {
    const textBlocks = request.content.filter((block): block is Extract<ChannelContentBlock, { type: 'text' | 'markdown' }> =>
      block.type === 'text' || block.type === 'markdown');
    const media = request.content.filter((block): block is Extract<ChannelContentBlock, { type: 'image' | 'file' }> =>
      block.type === 'image' || block.type === 'file');
    const actions = request.content.flatMap((block) => block.type === 'actions' ? block.buttons : []);
    validateActions(actions);
    let nativeMessageId: string | undefined;

    if (textBlocks.length || (!media.length && actions.length)) {
      const markdown = textBlocks.some((block) => block.type === 'markdown');
      const text = textBlocks.map((block) => block.text).join('\n\n') || '请选择操作：';
      const message = await this.call<TelegramMessage>('sendMessage', {
        ...address(request), text: markdown ? telegramMarkdownHtml(text) : text,
        ...(markdown ? { parse_mode: 'HTML' } : {}),
        ...replyMarkup(actions)
      }, undefined, true);
      nativeMessageId = String(message.message_id);
    }

    for (const [index, block] of media.entries()) {
      const method = block.type === 'image' ? 'sendPhoto' : 'sendDocument';
      const field = block.type === 'image' ? 'photo' : 'document';
      const form = new FormData();
      form.set('chat_id', request.target.conversationId);
      if (request.target.threadId) form.set('message_thread_id', request.target.threadId);
      if (request.replyTo) form.set('reply_parameters', JSON.stringify({ message_id: Number(request.replyTo) || request.replyTo }));
      const filename = block.type === 'file' ? block.name : `image-${index + 1}`;
      form.set(field, await mediaBlob(block.source), safeTelegramFilename(filename, field));
      if (index === media.length - 1 && actions.length) form.set('reply_markup', JSON.stringify(inlineKeyboard(actions)));
      const message = await this.call<TelegramMessage>(method, form, undefined, true);
      nativeMessageId ??= String(message.message_id);
    }
    if (!nativeMessageId) throw new ChannelDeliveryError('telegram_empty_message', 'permanent');
    return { requestId: request.id, nativeMessageId, deliveredAt: this.now().toISOString() };
  }

  async edit(request: ChannelEditRequest): Promise<ChannelSendReceipt> {
    const blocks = request.content.filter((block): block is Extract<ChannelContentBlock, { type: 'text' | 'markdown' }> =>
      block.type === 'text' || block.type === 'markdown');
    const text = blocks.map((block) => block.text).join('\n\n');
    if (!text) throw new ChannelDeliveryError('telegram_edit_text_required', 'permanent');
    const markdown = blocks.some((block) => block.type === 'markdown');
    const actions = request.content.flatMap((block) => block.type === 'actions' ? block.buttons : []);
    validateActions(actions);
    const message = await this.call<TelegramMessage>('editMessageText', {
      chat_id: request.target.conversationId,
      message_id: Number(request.nativeMessageId) || request.nativeMessageId,
      text: markdown ? telegramMarkdownHtml(text) : text,
      ...(markdown ? { parse_mode: 'HTML' } : {}),
      ...replyMarkup(actions)
    }, undefined, true);
    return { requestId: request.id, nativeMessageId: String(message.message_id), deliveredAt: this.now().toISOString() };
  }

  async setTyping(request: ChannelTypingRequest): Promise<void> {
    if (!request.active) return;
    await this.call('sendChatAction', {
      chat_id: request.target.conversationId,
      ...(request.target.threadId ? { message_thread_id: Number(request.target.threadId) || request.target.threadId } : {}),
      action: 'typing'
    }, undefined, true);
  }

  private async poll(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      try {
        const updates = await this.call<TelegramUpdate[]>('getUpdates', {
          offset: this.offset,
          timeout: this.config.pollingTimeoutSeconds,
          allowed_updates: ['message', 'callback_query']
        }, signal, false);
        failures = 0;
        for (const update of updates) {
          try {
            const event = await this.normalize(update, signal);
            if (event) await this.context?.emit(event);
            this.offset = Math.max(this.offset, update.update_id + 1);
          } catch (error) {
            if (!isPermanentInboundError(error)) throw error;
            this.offset = Math.max(this.offset, update.update_id + 1);
          }
        }
      } catch {
        if (signal.aborted) break;
        failures += 1;
        const base = Math.min(this.config.retryMaxMs, this.config.retryBaseMs * 2 ** Math.min(failures - 1, 10));
        await abortableDelay(Math.round(base * (0.8 + this.random() * 0.4)), signal);
      }
    }
  }

  private async normalize(update: TelegramUpdate, signal: AbortSignal): Promise<ChannelInboundEvent | undefined> {
    if (update.message) return this.normalizeMessage(update, update.message, signal);
    if (update.callback_query) {
      await this.call('answerCallbackQuery', { callback_query_id: update.callback_query.id }, signal, false);
      return this.normalizeInteraction(update, update.callback_query);
    }
    return undefined;
  }

  private async normalizeMessage(update: TelegramUpdate, message: TelegramMessage, signal: AbortSignal): Promise<ChannelInboundEvent> {
    const id = `telegram_${this.instanceId}_${update.update_id}`;
    const content: ChannelContentBlock[] = [];
    if (message.photo?.length) {
      const photo = [...message.photo].sort((left, right) => (right.file_size ?? 0) - (left.file_size ?? 0))[0]!;
      content.push({ type: 'image', source: await this.download(photo, id, 'image.jpg', this.config.maxImageBytes, signal), ...(message.caption ? { alt: message.caption } : {}) });
    }
    if (message.document) {
      content.push({
        type: 'file', source: await this.download(message.document, id, message.document.file_name ?? 'document', this.config.maxFileBytes, signal),
        name: safeTelegramFilename(message.document.file_name, 'document'),
        ...(message.document.mime_type ? { mimeType: message.document.mime_type } : {})
      });
    }
    const text = message.text ?? message.caption;
    return {
      id, kind: 'message', channel: { kind: 'telegram', instanceId: this.instanceId },
      conversation: conversation(message), sender: sender(message.from),
      message: {
        id: String(message.message_id), ...(text ? { text } : {}), ...(content.length ? { content } : {}),
        ...(message.reply_to_message ? { replyTo: String(message.reply_to_message.message_id) } : {}),
        ...mentions(text, message.entities ?? message.caption_entities ?? [])
      },
      receivedAt: this.now().toISOString(), dedupeKey: `update:${update.update_id}`,
      security: { verified: true, verificationMethod: 'polling_api' }
    };
  }

  private normalizeInteraction(update: TelegramUpdate, query: TelegramCallbackQuery): ChannelInboundEvent | undefined {
    if (!query.message || !query.data) return undefined;
    return {
      id: `telegram_${this.instanceId}_${update.update_id}`, kind: 'interaction',
      channel: { kind: 'telegram', instanceId: this.instanceId }, conversation: conversation(query.message),
      sender: sender(query.from), interaction: { actionToken: query.data },
      receivedAt: this.now().toISOString(), dedupeKey: `update:${update.update_id}`,
      security: { verified: true, verificationMethod: 'polling_api' }
    };
  }

  private async download(file: TelegramFile, eventId: string, name: string, maximum: number, signal: AbortSignal): Promise<ChannelMediaSource> {
    if (file.file_size !== undefined && file.file_size > maximum) throw new Error('telegram_attachment_too_large');
    const remote = await this.call<TelegramFile>('getFile', { file_id: file.file_id }, signal, false);
    if (!remote.file_path || remote.file_path.startsWith('/') || remote.file_path.split('/').includes('..')) {
      throw new Error('telegram_unsafe_file_path');
    }
    const encodedPath = remote.file_path.split('/').map(encodeURIComponent).join('/');
    const response = await this.fetch(`${this.apiBaseUrl}/file/bot${this.options.botToken}/${encodedPath}`, { signal });
    if (!response.ok) throw new Error(`telegram_file_download_failed: ${response.status}`);
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength > maximum) throw new Error('telegram_attachment_too_large');
    const directory = path.join(this.config.cacheDirectory, safeTelegramFilename(eventId, 'event'));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const digest = createHash('sha256').update(file.file_id).digest('hex').slice(0, 12);
    const filename = `${digest}-${safeTelegramFilename(name, 'attachment')}`;
    const localPath = path.join(directory, filename);
    await writeFile(localPath, data, { mode: 0o600 });
    return { kind: 'local_file', path: localPath };
  }

  private async call<T>(method: string, body: Record<string, unknown> | FormData, signal: AbortSignal | undefined, outbound: boolean): Promise<T> {
    let response: Response;
    try {
      response = await this.fetch(`${this.apiBaseUrl}/bot${this.options.botToken}/${method}`, {
        method: 'POST', ...(signal ? { signal } : {}),
        ...(body instanceof FormData ? { body } : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (outbound) throw new ChannelDeliveryError('telegram_delivery_outcome_unknown', 'unknown', { cause: error });
      throw new Error('telegram_transport_failed', { cause: error });
    }
    let envelope: TelegramResponse<T>;
    try { envelope = await response.json() as TelegramResponse<T>; }
    catch { throw outbound ? new ChannelDeliveryError('telegram_invalid_response', 'unknown') : new Error('telegram_invalid_response'); }
    if (!response.ok || !envelope.ok || envelope.result === undefined) {
      const message = `telegram_api_failed: ${envelope.error_code ?? response.status} ${envelope.description ?? ''}`.trim();
      if (!outbound) throw new Error(message);
      const retryable = response.status === 429 || response.status >= 500;
      throw new ChannelDeliveryError(message, retryable ? 'retryable' : 'permanent');
    }
    return envelope.result;
  }
}

function address(request: ChannelSendRequest): Record<string, unknown> {
  return {
    chat_id: request.target.conversationId,
    ...(request.target.threadId ? { message_thread_id: Number(request.target.threadId) || request.target.threadId } : {}),
    ...(request.replyTo ? { reply_parameters: { message_id: Number(request.replyTo) || request.replyTo } } : {})
  };
}

function inlineKeyboard(actions: ChannelActionButton[]): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  return { inline_keyboard: actions.map((button) => [{ text: button.label, callback_data: button.actionToken }]) };
}

function validateActions(actions: ChannelActionButton[]): void {
  if (actions.length > (TELEGRAM_CAPABILITIES.limits.maxButtons ?? 8)) {
    throw new ChannelDeliveryError('telegram_too_many_buttons', 'permanent');
  }
  if (actions.some((button) => Buffer.byteLength(button.actionToken, 'utf8') > 64)) {
    throw new ChannelDeliveryError('telegram_action_token_too_long', 'permanent');
  }
}

function replyMarkup(actions: ChannelActionButton[]): Record<string, unknown> {
  return actions.length ? { reply_markup: inlineKeyboard(actions) } : {};
}

function conversation(message: TelegramMessage): ChannelInboundEvent['conversation'] {
  return {
    id: String(message.chat.id), type: message.chat.type === 'private' ? 'direct' : 'group',
    ...(message.message_thread_id !== undefined ? { threadId: String(message.message_thread_id) } : {})
  };
}

function sender(user: TelegramUser | undefined): ChannelInboundEvent['sender'] {
  if (!user) return { id: 'unknown' };
  const displayName = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username;
  return { id: String(user.id), ...(displayName ? { displayName } : {}), ...(user.is_bot !== undefined ? { isBot: user.is_bot } : {}) };
}

function mentions(text: string | undefined, entities: Array<{ type: string; offset: number; length: number; user?: TelegramUser }>): Pick<NonNullable<ChannelInboundEvent['message']>, 'mentions'> | Record<string, never> {
  if (!text) return {};
  const normalized = entities.flatMap((entity) => {
    if (entity.type === 'text_mention' && entity.user) return [{ id: String(entity.user.id), displayName: text.slice(entity.offset, entity.offset + entity.length) }];
    if (entity.type === 'mention') {
      const value = text.slice(entity.offset, entity.offset + entity.length).replace(/^@/u, '');
      return [{ id: value, displayName: value }];
    }
    return [];
  });
  return normalized.length ? { mentions: normalized } : {};
}

async function mediaBlob(source: ChannelMediaSource): Promise<Blob> {
  if (source.kind === 'buffer') return new Blob([source.data as BlobPart], { type: source.mimeType });
  return new Blob([await readFile(source.path)]);
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    const abort = () => finish();
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve();
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

function isPermanentInboundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith('telegram_attachment_too_large') || message.startsWith('telegram_unsafe_file_path');
}
