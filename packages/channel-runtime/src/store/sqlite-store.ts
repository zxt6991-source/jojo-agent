import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  ChannelBinding,
  ChannelActionToken,
  ChannelInboundEvent,
  ChannelInstance,
  ChannelOutboxItem,
  ChannelPairing,
  ChannelSendRequest
} from '@desktop-agent/channel-core';
import { assertChannelInstanceSecrets } from '@desktop-agent/channel-core';
import { CHANNEL_SCHEMA_SQL, CHANNEL_SCHEMA_VERSION } from './schema.js';
import type { ChannelInboundStatus, ChannelStore } from './store.js';

type Row = Record<string, unknown>;

function text(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`channel_sqlite_corrupted: ${field}`);
  return value;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function integer(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`channel_sqlite_corrupted: ${field}`);
  return value;
}

function json<T>(value: unknown, field: string): T {
  try { return JSON.parse(text(value, field), jsonReviver) as T; }
  catch { throw new Error(`channel_sqlite_corrupted: ${field}`); }
}

function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, child) => child instanceof Uint8Array
    ? { __channelUint8Array: Buffer.from(child).toString('base64') }
    : child);
}

function jsonReviver(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && '__channelUint8Array' in value) {
    const encoded = (value as { __channelUint8Array?: unknown }).__channelUint8Array;
    if (typeof encoded === 'string') return Uint8Array.from(Buffer.from(encoded, 'base64'));
  }
  return value;
}

function instanceFromRow(row: Row): ChannelInstance {
  return {
    id: text(row.id, 'instance.id'), kind: text(row.kind, 'instance.kind'), name: text(row.name, 'instance.name'),
    enabled: integer(row.enabled, 'instance.enabled') === 1,
    config: json<Record<string, unknown>>(row.config_json, 'instance.config_json'),
    secretRefs: json<Record<string, string>>(row.secret_refs_json, 'instance.secret_refs_json'),
    fingerprint: text(row.fingerprint, 'instance.fingerprint'), revision: integer(row.revision, 'instance.revision'),
    createdAt: text(row.created_at, 'instance.created_at'), updatedAt: text(row.updated_at, 'instance.updated_at')
  };
}

function bindingFromRow(row: Row): ChannelBinding {
  const routing = json<ChannelBinding['routing']>(row.routing_json, 'binding.routing_json');
  const policy = json<ChannelBinding['policy']>(row.policy_json, 'binding.policy_json');
  return {
    id: text(row.id, 'binding.id'), instanceId: text(row.instance_id, 'binding.instance_id'),
    conversation: {
      id: text(row.conversation_id, 'binding.conversation_id'),
      type: text(row.conversation_type, 'binding.conversation_type') as 'direct' | 'group',
      ...(optionalText(row.thread_id) ? { threadId: optionalText(row.thread_id)! } : {})
    },
    routing, policy, revision: integer(row.revision, 'binding.revision'),
    createdAt: text(row.created_at, 'binding.created_at'), updatedAt: text(row.updated_at, 'binding.updated_at')
  };
}

function pairingFromRow(row: Row): ChannelPairing {
  return {
    id: text(row.id, 'pairing.id'), instanceId: text(row.instance_id, 'pairing.instance_id'),
    conversationId: text(row.conversation_id, 'pairing.conversation_id'), senderId: text(row.sender_id, 'pairing.sender_id'),
    codeHash: text(row.code_hash, 'pairing.code_hash'),
    status: text(row.status, 'pairing.status') as ChannelPairing['status'],
    expiresAt: text(row.expires_at, 'pairing.expires_at'), createdAt: text(row.created_at, 'pairing.created_at'),
    ...(optionalText(row.resolved_at) ? { resolvedAt: optionalText(row.resolved_at)! } : {})
  };
}

function actionTokenFromRow(row: Row): ChannelActionToken {
  return {
    tokenHash: text(row.token_hash, 'action_token.token_hash'),
    actionType: text(row.action_type, 'action_token.action_type') as 'approval',
    payload: json<ChannelActionToken['payload']>(row.payload_json, 'action_token.payload_json'),
    expiresAt: text(row.expires_at, 'action_token.expires_at'),
    createdAt: text(row.created_at, 'action_token.created_at'),
    ...(optionalText(row.allowed_sender_id) ? { allowedSenderId: optionalText(row.allowed_sender_id)! } : {}),
    ...(optionalText(row.used_at) ? { usedAt: optionalText(row.used_at)! } : {})
  };
}

function outboxFromRow(row: Row): ChannelOutboxItem {
  const request = json<ChannelSendRequest>(row.payload_json, 'outbox.payload_json');
  return {
    id: text(row.id, 'outbox.id'), instanceId: text(row.instance_id, 'outbox.instance_id'),
    conversationId: text(row.conversation_id, 'outbox.conversation_id'), request,
    idempotencyKey: text(row.idempotency_key, 'outbox.idempotency_key'),
    status: text(row.status, 'outbox.status') as ChannelOutboxItem['status'],
    attemptCount: integer(row.attempt_count, 'outbox.attempt_count'), createdAt: text(row.created_at, 'outbox.created_at'),
    ...(optionalText(row.binding_id) ? { bindingId: optionalText(row.binding_id)! } : {}),
    ...(optionalText(row.thread_id) ? { threadId: optionalText(row.thread_id)! } : {}),
    ...(optionalText(row.next_attempt_at) ? { nextAttemptAt: optionalText(row.next_attempt_at)! } : {}),
    ...(optionalText(row.delivered_at) ? { deliveredAt: optionalText(row.delivered_at)! } : {}),
    ...(optionalText(row.native_message_id) ? { nativeMessageId: optionalText(row.native_message_id)! } : {}),
    ...(optionalText(row.last_error) ? { lastError: optionalText(row.last_error)! } : {})
  };
}

export class SqliteChannelStore implements ChannelStore {
  private readonly database: DatabaseSync;

  constructor(filename: string) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.database = new DatabaseSync(filename);
    this.database.exec('PRAGMA journal_mode = WAL;');
    const version = this.database.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version.user_version > CHANNEL_SCHEMA_VERSION) throw new Error(`channel_sqlite_version_unsupported: ${version.user_version}`);
    this.database.exec(CHANNEL_SCHEMA_SQL);
    this.database.exec(`PRAGMA user_version = ${CHANNEL_SCHEMA_VERSION};`);
  }

  async listInstances(): Promise<ChannelInstance[]> {
    return (this.database.prepare('SELECT * FROM channel_instances ORDER BY created_at').all() as Row[]).map(instanceFromRow);
  }
  async getInstance(id: string): Promise<ChannelInstance | undefined> {
    const row = this.database.prepare('SELECT * FROM channel_instances WHERE id = ?').get(id) as Row | undefined;
    return row ? instanceFromRow(row) : undefined;
  }
  async saveInstance(instance: ChannelInstance, expectedRevision?: number): Promise<ChannelInstance> {
    assertChannelInstanceSecrets(instance);
    const current = await this.getInstance(instance.id);
    if (!current) {
      if (expectedRevision !== undefined) throw new Error(`channel_instance_revision_conflict: ${instance.id}`);
      this.database.prepare(`INSERT INTO channel_instances
        (id, kind, name, enabled, config_json, secret_refs_json, fingerprint, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(instance.id, instance.kind, instance.name, instance.enabled ? 1 : 0, stringify(instance.config),
          stringify(instance.secretRefs), instance.fingerprint, instance.revision, instance.createdAt, instance.updatedAt);
    } else {
      const expected = expectedRevision ?? current.revision;
      const result = this.database.prepare(`UPDATE channel_instances SET kind = ?, name = ?, enabled = ?, config_json = ?,
        secret_refs_json = ?, fingerprint = ?, revision = ?, updated_at = ? WHERE id = ? AND revision = ?`)
        .run(instance.kind, instance.name, instance.enabled ? 1 : 0, stringify(instance.config), stringify(instance.secretRefs),
          instance.fingerprint, instance.revision, instance.updatedAt, instance.id, expected);
      if (result.changes !== 1) throw new Error(`channel_instance_revision_conflict: ${instance.id}`);
    }
    return (await this.getInstance(instance.id))!;
  }
  async deleteInstance(id: string): Promise<void> { this.database.prepare('DELETE FROM channel_instances WHERE id = ?').run(id); }

  async listBindings(instanceId?: string): Promise<ChannelBinding[]> {
    const rows = instanceId
      ? this.database.prepare('SELECT * FROM channel_bindings WHERE instance_id = ? ORDER BY created_at').all(instanceId)
      : this.database.prepare('SELECT * FROM channel_bindings ORDER BY created_at').all();
    return (rows as Row[]).map(bindingFromRow);
  }
  async getBinding(id: string): Promise<ChannelBinding | undefined> {
    const row = this.database.prepare('SELECT * FROM channel_bindings WHERE id = ?').get(id) as Row | undefined;
    return row ? bindingFromRow(row) : undefined;
  }
  async findBinding(instanceId: string, conversationId: string, threadId?: string): Promise<ChannelBinding | undefined> {
    const exact = this.database.prepare(`SELECT * FROM channel_bindings WHERE instance_id = ? AND conversation_id = ?
      AND IFNULL(thread_id, '') = ?`).get(instanceId, conversationId, threadId ?? '') as Row | undefined;
    if (exact) return bindingFromRow(exact);
    if (!threadId) return undefined;
    const fallback = this.database.prepare(`SELECT * FROM channel_bindings WHERE instance_id = ? AND conversation_id = ?
      AND thread_id IS NULL`).get(instanceId, conversationId) as Row | undefined;
    return fallback ? bindingFromRow(fallback) : undefined;
  }
  async saveBinding(binding: ChannelBinding, expectedRevision?: number): Promise<ChannelBinding> {
    const current = await this.getBinding(binding.id);
    const values = [binding.instanceId, binding.conversation.id, binding.conversation.threadId ?? null,
      binding.conversation.type, binding.routing.sessionMode, binding.routing.sessionId ?? null,
      binding.routing.workspaceRoot ?? null, binding.routing.providerId ?? null, binding.routing.model ?? null,
      stringify(binding.routing), stringify(binding.policy), binding.revision, binding.updatedAt];
    try {
      if (!current) {
        if (expectedRevision !== undefined) throw new Error(`channel_binding_revision_conflict: ${binding.id}`);
        this.database.prepare(`INSERT INTO channel_bindings
          (id, instance_id, conversation_id, thread_id, conversation_type, session_mode, session_id, workspace_root,
           provider_id, model, routing_json, policy_json, revision, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(binding.id, ...values.slice(0, 12), binding.createdAt, binding.updatedAt);
      } else {
        const expected = expectedRevision ?? current.revision;
        const result = this.database.prepare(`UPDATE channel_bindings SET instance_id = ?, conversation_id = ?, thread_id = ?,
          conversation_type = ?, session_mode = ?, session_id = ?, workspace_root = ?, provider_id = ?, model = ?,
          routing_json = ?, policy_json = ?, revision = ?, updated_at = ? WHERE id = ? AND revision = ?`)
          .run(...values, binding.id, expected);
        if (result.changes !== 1) throw new Error(`channel_binding_revision_conflict: ${binding.id}`);
      }
    } catch (error) {
      if (String(error).includes('idx_channel_binding_address') || String(error).includes('UNIQUE constraint failed')) {
        throw new Error(`channel_binding_conflict: ${binding.id}`);
      }
      throw error;
    }
    return (await this.getBinding(binding.id))!;
  }
  async deleteBinding(id: string): Promise<void> { this.database.prepare('DELETE FROM channel_bindings WHERE id = ?').run(id); }

  async claimInbound(event: ChannelInboundEvent): Promise<boolean> {
    try {
      this.database.prepare(`INSERT INTO channel_inbound_events
        (id, instance_id, dedupe_key, sender_id, conversation_id, received_at, status)
        VALUES (?, ?, ?, ?, ?, ?, 'received')`)
        .run(event.id, event.channel.instanceId, event.dedupeKey, event.sender.id, event.conversation.id, event.receivedAt);
      return true;
    } catch (error) {
      if (String(error).includes('UNIQUE constraint failed')) return false;
      throw error;
    }
  }
  async markInbound(eventId: string, status: ChannelInboundStatus, error?: string): Promise<void> {
    const result = this.database.prepare('UPDATE channel_inbound_events SET status = ?, error = ? WHERE id = ?')
      .run(status, error ?? null, eventId);
    if (result.changes !== 1) throw new Error(`channel_inbound_not_found: ${eventId}`);
  }

  async findPendingPairing(instanceId: string, conversationId: string, senderId: string): Promise<ChannelPairing | undefined> {
    const row = this.database.prepare(`SELECT * FROM channel_pairings WHERE instance_id = ? AND conversation_id = ?
      AND sender_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`)
      .get(instanceId, conversationId, senderId) as Row | undefined;
    return row ? pairingFromRow(row) : undefined;
  }
  async listPairings(status?: ChannelPairing['status']): Promise<ChannelPairing[]> {
    const rows = status
      ? this.database.prepare('SELECT * FROM channel_pairings WHERE status = ? ORDER BY created_at DESC').all(status)
      : this.database.prepare('SELECT * FROM channel_pairings ORDER BY created_at DESC').all();
    return (rows as Row[]).map(pairingFromRow);
  }
  async savePairing(pairing: ChannelPairing): Promise<ChannelPairing> {
    this.database.prepare(`INSERT INTO channel_pairings
      (id, instance_id, conversation_id, sender_id, code_hash, status, expires_at, created_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(pairing.id, pairing.instanceId, pairing.conversationId, pairing.senderId, pairing.codeHash,
        pairing.status, pairing.expiresAt, pairing.createdAt, pairing.resolvedAt ?? null);
    return pairing;
  }
  async resolvePairing(id: string, status: 'approved' | 'rejected', resolvedAt: string): Promise<ChannelPairing> {
    const result = this.database.prepare(`UPDATE channel_pairings SET status = ?, resolved_at = ?
      WHERE id = ? AND status = 'pending'`).run(status, resolvedAt, id);
    if (result.changes !== 1) throw new Error(`channel_pairing_not_pending: ${id}`);
    const row = this.database.prepare('SELECT * FROM channel_pairings WHERE id = ?').get(id) as Row;
    return pairingFromRow(row);
  }

  async saveActionTokens(tokens: ChannelActionToken[]): Promise<void> {
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      const statement = this.database.prepare(`INSERT INTO channel_action_tokens
        (token_hash, action_type, payload_json, allowed_sender_id, expires_at, created_at, used_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const token of tokens) statement.run(token.tokenHash, token.actionType, stringify(token.payload),
        token.allowedSenderId ?? null, token.expiresAt, token.createdAt, token.usedAt ?? null);
      this.database.exec('COMMIT;');
    } catch (error) {
      this.database.exec('ROLLBACK;');
      throw error;
    }
  }
  async consumeActionToken(tokenHash: string, senderId: string, now: string): Promise<ChannelActionToken> {
    const result = this.database.prepare(`UPDATE channel_action_tokens SET used_at = ? WHERE token_hash = ?
      AND used_at IS NULL AND expires_at > ? AND (allowed_sender_id IS NULL OR allowed_sender_id = ?)`)
      .run(now, tokenHash, now, senderId);
    const row = this.database.prepare('SELECT * FROM channel_action_tokens WHERE token_hash = ?').get(tokenHash) as Row | undefined;
    if (result.changes === 1 && row) return actionTokenFromRow(row);
    if (!row) throw new Error('channel_action_token_invalid');
    const token = actionTokenFromRow(row);
    if (token.usedAt) throw new Error('channel_action_token_used');
    if (token.expiresAt <= now) throw new Error('channel_action_token_expired');
    throw new Error('channel_action_token_sender_mismatch');
  }
  async invalidateApprovalTokens(approvalId: string, now: string): Promise<void> {
    const rows = this.database.prepare(`SELECT * FROM channel_action_tokens WHERE action_type = 'approval' AND used_at IS NULL`).all() as Row[];
    const statement = this.database.prepare('UPDATE channel_action_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL');
    for (const row of rows) {
      const token = actionTokenFromRow(row);
      if (token.payload.approvalId === approvalId) statement.run(now, token.tokenHash);
    }
  }

  async enqueueOutbox(item: ChannelOutboxItem): Promise<ChannelOutboxItem> {
    try {
      this.database.prepare(`INSERT INTO channel_outbox
        (id, instance_id, binding_id, conversation_id, thread_id, payload_json, mode, correlation_json,
         idempotency_key, status, attempt_count, next_attempt_at, created_at, delivered_at, native_message_id, last_error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(item.id, item.instanceId, item.bindingId ?? null, item.conversationId, item.threadId ?? null,
          stringify(item.request), item.request.mode ?? 'system', item.request.correlation ? stringify(item.request.correlation) : null,
          item.idempotencyKey, item.status, item.attemptCount, item.nextAttemptAt ?? null, item.createdAt,
          item.deliveredAt ?? null, item.nativeMessageId ?? null, item.lastError ?? null);
    } catch (error) {
      if (!String(error).includes('UNIQUE constraint failed')) throw error;
      const existing = this.database.prepare('SELECT * FROM channel_outbox WHERE idempotency_key = ?')
        .get(item.idempotencyKey) as Row | undefined;
      if (existing) return outboxFromRow(existing);
      throw error;
    }
    return (await this.getOutbox(item.id))!;
  }
  async getOutbox(id: string): Promise<ChannelOutboxItem | undefined> {
    const row = this.database.prepare('SELECT * FROM channel_outbox WHERE id = ?').get(id) as Row | undefined;
    return row ? outboxFromRow(row) : undefined;
  }
  async listOutbox(options: { instanceId?: string; status?: ChannelOutboxItem['status']; limit?: number } = {}): Promise<ChannelOutboxItem[]> {
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (options.instanceId) { clauses.push('instance_id = ?'); values.push(options.instanceId); }
    if (options.status) { clauses.push('status = ?'); values.push(options.status); }
    values.push(options.limit ?? 100);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return (this.database.prepare(`SELECT * FROM channel_outbox ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...values) as Row[]).map(outboxFromRow);
  }
  async listReadyOutbox(now: string, limit = 100): Promise<ChannelOutboxItem[]> {
    return (this.database.prepare(`SELECT * FROM channel_outbox WHERE status = 'pending'
      AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at LIMIT ?`).all(now, limit) as Row[]).map(outboxFromRow);
  }
  async updateOutbox(id: string, patch: Partial<Omit<ChannelOutboxItem, 'id' | 'request' | 'createdAt'>>): Promise<ChannelOutboxItem> {
    const current = await this.getOutbox(id);
    if (!current) throw new Error(`channel_delivery_not_found: ${id}`);
    const updated = { ...current, ...patch };
    this.database.prepare(`UPDATE channel_outbox SET instance_id = ?, binding_id = ?, conversation_id = ?, thread_id = ?,
      idempotency_key = ?, status = ?, attempt_count = ?, next_attempt_at = ?, delivered_at = ?, native_message_id = ?, last_error = ?
      WHERE id = ?`).run(updated.instanceId, updated.bindingId ?? null, updated.conversationId, updated.threadId ?? null,
        updated.idempotencyKey, updated.status, updated.attemptCount, updated.nextAttemptAt ?? null,
        updated.deliveredAt ?? null, updated.nativeMessageId ?? null, updated.lastError ?? null, id);
    return (await this.getOutbox(id))!;
  }
  async recoverOutbox(): Promise<void> {
    this.database.prepare(`UPDATE channel_outbox SET status = 'unknown', last_error = COALESCE(last_error,
      'Process stopped after dispatch began; delivery outcome is unknown.') WHERE status = 'sending'`).run();
  }

  async close(): Promise<void> { this.database.close(); }
}
