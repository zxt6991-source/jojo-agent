import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  ConversationMapHistoryQuerySchema, ConversationMapScopeSchema, ConversationMapSourceResultSchema,
  type ConversationMapHistoryPage, type ConversationMapHistoryQuery, type ConversationMapMessage,
  type ConversationMapScope, type ConversationMapSourceResult, type ConversationTurnRecord
} from '@desktop-agent/contracts';

type Row = Record<string, unknown>;
type SourceQuery = { sessionId: string; entryId: string; scope: ConversationMapScope };

/** Exact directory identity, including symlinks; never uses path-prefix authorization. */
export function canonicalConversationMapDirectory(directory: string): string {
  if (!path.isAbsolute(directory) || directory.includes('\0')) throw new Error('conversation_map_invalid_project');
  const normalized = path.resolve(directory);
  try { return realpathSync.native(normalized); }
  catch { return normalized; }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// The Desktop caller supplies its current authorization on EVERY page and source
// read. Store metadata and durable execution provenance narrow that authority.
// A mixed personal/channel session is conservatively excluded as a whole because
// entries do not carry an unambiguous operation ID in the current runtime schema.
function authorizedSessions(db: DatabaseSync, scope: ConversationMapScope, allowed: readonly string[]): string[] {
  ConversationMapScopeSchema.parse(scope);
  if (allowed.length > 1000) throw new Error('conversation_map_scope_too_large');
  if (!allowed.length) return [];
  if (!allowed.every(id => typeof id === 'string' && id.length > 0 && id.length <= 256)) throw new Error('conversation_map_invalid_scope');
  const placeholders = allowed.map(() => '?').join(',');
  const rows = db.prepare(`SELECT s.id, s.metadata_json FROM sessions s
    WHERE s.id IN (${placeholders}) AND NOT EXISTS (
      SELECT 1 FROM operations o WHERE o.session_id = s.id AND o.lane = 'main' AND (
        coalesce(json_extract(o.meta_json, '$.execution.actor.kind'), 'main') <> 'main'
        OR coalesce(json_extract(o.meta_json, '$.execution.trigger.kind'), 'user') NOT IN ('user', 'resume')
        OR json_extract(o.meta_json, '$.execution.team') IS NOT NULL
        OR json_extract(o.meta_json, '$.execution.workflow') IS NOT NULL
      )
    )`).all(...allowed) as Row[];
  const project = scope.kind === 'project' ? canonicalConversationMapDirectory(scope.workingDirectory) : null;
  return rows.filter(row => {
    const metadata = object(row.metadata_json ? JSON.parse(String(row.metadata_json)) : {});
    if (metadata.source !== undefined && !['main', 'desktop'].includes(String(metadata.source))) return false;
    if (['channel', 'team', 'teamId', 'spawn', 'parentSessionId', 'scheduler', 'scheduleId', 'workflow'].some(key => metadata[key] !== undefined && metadata[key] !== null)) return false;
    if (project === null) return true;
    const executionScope = object(metadata.__runtimeExecutionScope);
    if (executionScope.kind !== undefined && executionScope.kind !== 'workspace') return false;
    const directory = executionScope.workingDirectory ?? metadata.__runtimeWorkingDirectory ?? object(metadata.projectIdentity).canonicalPath;
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) return false;
    return canonicalConversationMapDirectory(directory) === project;
  }).map(row => String(row.id));
}

const body = `(SELECT group_concat(json_extract(value, '$.text'), char(10))
  FROM json_each(e.payload_json, '$.message.content')
  WHERE json_extract(value, '$.type') = 'text' AND json_extract(value, '$.attachment') IS NULL)`;
const visibleMessage = `e.type = 'message'
  AND json_extract(e.payload_json, '$.message.role') IN ('user', 'assistant')
  AND coalesce(json_extract(e.payload_json, '$.message.metadata.internal'), 0) = 0
  AND json_extract(e.payload_json, '$.message.metadata.source') IS NULL
  AND json_extract(e.payload_json, '$.message.metadata.automation') IS NULL
  AND json_extract(e.payload_json, '$.message.metadata.hostToolTrace') IS NULL`;

function mainPath(allowed: readonly string[]): string {
  // UNION deduplicates ancestors and terminates even if a corrupted graph cycles.
  return `WITH RECURSIVE main_path(id, session_id, parent_id) AS (
    SELECT e.id, e.session_id, e.parent_id FROM lanes l
      JOIN entries e ON e.id = l.leaf_id AND e.session_id = l.session_id
      WHERE l.name = 'main' AND l.session_id IN (${allowed.map(() => '?').join(',')})
    UNION
    SELECT e.id, e.session_id, e.parent_id FROM entries e JOIN main_path p
      ON e.id = p.parent_id AND e.session_id = p.session_id
  )`;
}
const columns = `e.id, e.session_id, e.seq,
  json_extract(e.payload_json, '$.message.id') AS message_id,
  json_extract(e.payload_json, '$.message.createdAt') AS message_time,
  json_extract(e.payload_json, '$.message.role') AS role,
  substr(${body}, 1, 3000) AS body, length(${body}) AS body_length`;

function message(row: Row): ConversationMapMessage {
  const raw = String(row.body ?? '');
  const text = raw.slice(0, 3000).replace(/[\uD800-\uDBFF]$/u, '');
  return {
    reference: { sessionId: String(row.session_id), entryId: String(row.id), seq: Number(row.seq),
      createdAt: String(row.message_time), role: row.role as 'user' | 'assistant' },
    text, truncated: raw.length > text.length || Number(row.body_length) > Array.from(raw).length
  };
}

export function readConversationMapPage(db: DatabaseSync, input: ConversationMapHistoryQuery, allowedSessionIds: readonly string[]): ConversationMapHistoryPage {
  const query = ConversationMapHistoryQuerySchema.parse(input);
  const allowed = authorizedSessions(db, query.scope, allowedSessionIds);
  if (!allowed.length) return { turns: [], hasMore: false };
  const cte = mainPath(allowed);
  const after = query.cursor ? `AND (julianday(json_extract(e.payload_json, '$.message.createdAt')), e.session_id, e.seq) > (julianday(?), ?, ?)` : '';
  const rows = db.prepare(`${cte} SELECT ${columns} FROM entries e
    JOIN main_path p ON p.id = e.id AND p.session_id = e.session_id
    WHERE ${visibleMessage} AND json_extract(e.payload_json, '$.message.role') = 'user'
    AND length(trim(${body})) > 0
    AND julianday(json_extract(e.payload_json, '$.message.createdAt')) >= julianday(?)
    AND julianday(json_extract(e.payload_json, '$.message.createdAt')) < julianday(?) ${after}
    ORDER BY julianday(message_time), e.session_id, e.seq LIMIT ?`).all(
    ...allowed, query.rangeStart, query.rangeEnd,
    ...(query.cursor ? [query.cursor.createdAt, query.cursor.sessionId, query.cursor.seq] : []), query.limit + 1
  ) as Row[];
  const hasMore = rows.length > query.limit;
  const turns: ConversationTurnRecord[] = rows.slice(0, query.limit).map(row => {
    const sessionId = String(row.session_id);
    const sessionPath = mainPath([sessionId]);
    // All user messages (including nontext and excluded automation inputs) end a
    // turn, so their following assistant cannot attach to an earlier question.
    const nextUser = db.prepare(`${sessionPath} SELECT min(e.seq) AS seq FROM entries e JOIN main_path p ON p.id = e.id
      WHERE e.session_id = ? AND e.seq > ? AND e.type = 'message'
      AND json_extract(e.payload_json, '$.message.role') = 'user'`).get(sessionId, sessionId, Number(row.seq)) as Row;
    const responses = db.prepare(`${sessionPath} SELECT ${columns} FROM entries e JOIN main_path p ON p.id = e.id
      WHERE e.session_id = ? AND e.seq > ? AND e.seq < ? AND ${visibleMessage}
      AND json_extract(e.payload_json, '$.message.role') = 'assistant' AND length(trim(${body})) > 0
      AND julianday(json_extract(e.payload_json, '$.message.createdAt')) >= julianday(?)
      AND julianday(json_extract(e.payload_json, '$.message.createdAt')) < julianday(?)
      ORDER BY e.seq LIMIT 21`).all(sessionId, sessionId, Number(row.seq),
      nextUser.seq === null ? Number.MAX_SAFE_INTEGER : Number(nextUser.seq), query.rangeStart, query.rangeEnd) as Row[];
    const user = message(row);
    const assistants = responses.slice(0, 20).map(message);
    return { sessionId: user.reference.sessionId, turnId: user.reference.entryId, createdAt: user.reference.createdAt,
      user, assistants, truncated: user.truncated || assistants.some(item => item.truncated) || responses.length > 20 };
  });
  const last = turns.at(-1)?.user.reference;
  return { turns, hasMore, ...(hasMore && last ? { nextCursor: { createdAt: last.createdAt, sessionId: last.sessionId, seq: last.seq } } : {}) };
}

export function readConversationMapSource(db: DatabaseSync, input: SourceQuery, allowedSessionIds: readonly string[]): ConversationMapSourceResult {
  // Scope is rechecked against current session metadata, then ancestry and message
  // visibility are read afresh. A deleted or abandoned source is unavailable.
  const allowed = authorizedSessions(db, input.scope, allowedSessionIds);
  if (!allowed.includes(input.sessionId)) return { available: false };
  const row = db.prepare(`${mainPath([input.sessionId])} SELECT ${columns} FROM entries e
    JOIN main_path p ON p.id = e.id WHERE e.session_id = ? AND e.id = ? AND ${visibleMessage}
    AND length(trim(${body})) > 0`).get(input.sessionId, input.sessionId, input.entryId) as Row | undefined;
  if (!row) return { available: false };
  return ConversationMapSourceResultSchema.parse({ available: true, ...message(row), messageId: String(row.message_id) });
}
