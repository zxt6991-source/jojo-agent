import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { VoiceDeliverySegment, VoiceDeliveryStore } from '@desktop-agent/speech';
import { z } from 'zod';
const id = z.string().min(1).max(256);
const SegmentSchema = z.object({ id, voiceSessionId: id, turnId: id, runId: id, messageId: id.optional(), generation: z.number().int().nonnegative().safe(),
  sourceTextRange: z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }).strict().optional(),
  spokenText: z.string().max(20_000), playedMs: z.number().nonnegative(),
  state: z.enum(['queued', 'synthesizing', 'ready', 'playing', 'partially_played', 'played', 'interrupted', 'cancelled', 'failed']) }).strict();

/** Separate component schema: no change to the asset or voice commit tables. */
export class SqliteVoiceDeliveryStore implements VoiceDeliveryStore {
  private readonly db: DatabaseSync;
  constructor(filename: string) {
    mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS voice_delivery_segments (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL
      ); CREATE INDEX IF NOT EXISTS voice_delivery_session ON voice_delivery_segments(session_id);`);
  }
  load(): VoiceDeliverySegment[] {
    return this.db.prepare('SELECT value FROM (SELECT rowid,value FROM voice_delivery_segments ORDER BY rowid DESC LIMIT 800) ORDER BY rowid').all()
      .map(row => SegmentSchema.parse(JSON.parse(String(row.value))) as VoiceDeliverySegment);
  }
  save(segment: VoiceDeliverySegment): void {
    SegmentSchema.parse(segment);
    this.db.prepare(`INSERT INTO voice_delivery_segments(id,session_id,run_id,value,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
      .run(segment.id, segment.voiceSessionId, segment.runId, JSON.stringify(segment), Date.now());
    this.db.prepare('DELETE FROM voice_delivery_segments WHERE rowid NOT IN (SELECT rowid FROM voice_delivery_segments ORDER BY rowid DESC LIMIT 1000)').run();
  }
  deleteSession(sessionId: string): void { this.db.prepare('DELETE FROM voice_delivery_segments WHERE session_id=?').run(sessionId); }
  close(): void { this.db.close(); }
}
