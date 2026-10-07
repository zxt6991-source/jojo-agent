import type { DatabaseSync } from 'node:sqlite';
import { SessionSearchQuerySchema, SessionReadWindowQuerySchema, type SessionSearchHit, type SessionSearchQuery, type SessionReadWindow, type SessionReadWindowQuery } from '@desktop-agent/contracts';

const bodySql = `(SELECT group_concat(json_extract(value, '$.text'), char(10)) FROM json_each(e.payload_json, '$.message.content') WHERE json_extract(value, '$.type') = 'text' AND json_extract(value, '$.attachment') IS NULL)`;
const eligibleSql = `e.type = 'message' AND json_extract(e.payload_json, '$.message.role') IN ('user', 'assistant') AND coalesce(json_extract(e.payload_json, '$.message.metadata.internal'), 0) = 0`;
const sourceSql = `CASE WHEN json_extract(e.payload_json, '$.message.metadata.source') = 'scheduler' OR json_extract(s.metadata_json, '$.source') = 'scheduler' THEN 'scheduler' WHEN json_extract(s.metadata_json, '$.source') = 'team' THEN 'team' WHEN json_extract(s.metadata_json, '$.source') IN ('spawn', 'subagent') THEN 'spawn' ELSE 'main' END`;
const projectSql = `coalesce(json_extract(s.metadata_json, '$.__runtimeExecutionScope.workingDirectory'), json_extract(s.metadata_json, '$.__runtimeWorkingDirectory'))`;
export function initializeSessionHistory(db: DatabaseSync): void {
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE name = 'session_message_fts'").get();
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS session_message_fts USING fts5(entry_id UNINDEXED, session_id UNINDEXED, body, tokenize='trigram');
    CREATE TRIGGER IF NOT EXISTS session_history_insert AFTER INSERT ON entries BEGIN
      INSERT INTO session_message_fts(entry_id, session_id, body)
      SELECT e.id, e.session_id, substr(${bodySql}, 1, 100000) FROM entries e WHERE e.id = new.id AND ${eligibleSql} AND ${bodySql} IS NOT NULL;
    END;
    CREATE TRIGGER IF NOT EXISTS session_history_delete AFTER DELETE ON entries BEGIN
      DELETE FROM session_message_fts WHERE entry_id = old.id;
    END;
    CREATE TRIGGER IF NOT EXISTS session_history_update AFTER UPDATE ON entries BEGIN
      DELETE FROM session_message_fts WHERE entry_id = old.id;
      INSERT INTO session_message_fts(entry_id, session_id, body)
      SELECT e.id, e.session_id, substr(${bodySql}, 1, 100000) FROM entries e WHERE e.id = new.id AND ${eligibleSql} AND ${bodySql} IS NOT NULL;
    END;
  `);
  if (!exists) db.exec(`INSERT INTO session_message_fts(entry_id, session_id, body) SELECT e.id, e.session_id, substr(${bodySql}, 1, 100000) FROM entries e WHERE ${eligibleSql} AND ${bodySql} IS NOT NULL`);
}
function hit(row: Record<string, unknown>, snippet: string): SessionSearchHit {
  return { sessionId: String(row.session_id), entryId: String(row.id), seq: Number(row.seq),
    createdAt: String(row.message_time), role: row.role as 'user' | 'assistant', source: row.source as SessionSearchHit['source'],
    ...(typeof row.project === 'string' ? { project: row.project } : {}), snippet: snippet.slice(0, 1600), score: Number(row.score ?? 0) };
}
// Only index-visible entries on the durable main path are returned. Abandoned
// branches and pending, unattached entries must not masquerade as conversation history.
const mainPathSql = `WITH RECURSIVE main_path(id, session_id, parent_id) AS (
  SELECT e.id, e.session_id, e.parent_id FROM lanes l JOIN entries e ON e.id = l.leaf_id AND e.session_id = l.session_id WHERE l.name = 'main'
  UNION ALL
  SELECT e.id, e.session_id, e.parent_id FROM entries e JOIN main_path p ON e.id = p.parent_id AND e.session_id = p.session_id
)`;
const columns = `e.id, e.session_id, e.seq, json_extract(e.payload_json, '$.message.createdAt') AS message_time, json_extract(e.payload_json, '$.message.role') AS role, ${sourceSql} AS source, ${projectSql} AS project`;
export function searchSessionMessages(db: DatabaseSync, input: SessionSearchQuery, allowed: readonly string[]): SessionSearchHit[] {
  const query = SessionSearchQuerySchema.parse(input);
  if (!allowed.length) return [];
  if (allowed.length > 1000) throw new Error('session_search_scope_too_large');
  const terms = query.query.split(/\s+/u).filter(Boolean).slice(0, 12);
  const fts = terms.every(term => [...term].length >= 3);
  const match = fts ? terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' AND ') : '';
  const allowedSql = allowed.map(() => '?').join(',');
  const sourceFilter = query.source === 'all' ? '' : `AND (${sourceSql}) = ?`;
  const where = fts ? 'session_message_fts MATCH ?' : terms.map(() => 'instr(lower(f.body), lower(?)) > 0').join(' AND ');
  const rank = fts ? 'bm25(session_message_fts)' : '0';
  const rows = db.prepare(` ${mainPathSql} SELECT ${columns}, ${rank} AS score, f.body AS body FROM session_message_fts f JOIN entries e ON e.id = f.entry_id JOIN sessions s ON s.id = e.session_id WHERE e.id IN (SELECT id FROM main_path) AND e.session_id IN (${allowedSql}) AND ${where} ${sourceFilter} ORDER BY CASE (${sourceSql}) WHEN 'main' THEN 0 WHEN 'scheduler' THEN 3 ELSE 2 END, score, e.created_at DESC LIMIT ?`).all(...allowed, ...(fts ? [match] : terms), ...(query.source === 'all' ? [] : [query.source]), query.limit) as Record<string, unknown>[];
  return rows.map(row => {
    const body = String(row.body);
    const start = Math.max(0, body.toLowerCase().indexOf(terms[0]!.toLowerCase()) - 120);
    return hit(row, body.slice(start, start + 1600));
  });
}
export function readSessionMessageWindow(db: DatabaseSync, input: SessionReadWindowQuery): SessionReadWindow {
  const query = SessionReadWindowQuerySchema.parse(input);
  const rows = db.prepare(` ${mainPathSql} SELECT ${columns}, ${bodySql} AS body FROM entries e JOIN sessions s ON s.id = e.session_id WHERE e.id IN (SELECT id FROM main_path) AND e.session_id = ? AND e.seq BETWEEN ? AND ? AND ${eligibleSql} ORDER BY e.seq`).all(query.sessionId, Math.max(0, query.anchorSeq - query.before), query.anchorSeq + query.after) as Record<string, unknown>[];
  let remaining = query.maxCharacters;
  const items: SessionReadWindow['items'] = [];
  let truncated = false;
  for (const row of rows) {
    if (remaining <= 0) { truncated = true; break; }
    const body = String(row.body ?? '');
    const content = body.slice(0, Math.min(3000, remaining));
    remaining -= content.length;
    const clipped = content.length < body.length;
    truncated ||= clipped;
    items.push({ ...hit(row, ''), content, truncated: clipped });
  }
  return { items, truncated };
}
