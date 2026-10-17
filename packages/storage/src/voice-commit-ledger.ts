import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

const identifier = z.string().min(1).max(256);
export const VoiceCommitInputSchema = z.object({
  voiceSessionId: identifier, voiceTurnId: identifier, sessionId: identifier,
  generation: z.number().int().nonnegative(), text: z.string().trim().min(1).max(20_000),
  providerId: identifier, model: z.string().min(1).max(512)
}).strict();
export type VoiceCommitInput = z.infer<typeof VoiceCommitInputSchema>;
export type VoiceCommitState = 'pending' | 'submitting' | 'committed' | 'failed';
export interface VoiceCommitRecord extends VoiceCommitInput {
  runId: string; laneId: 'main'; inputHash: string; state: VoiceCommitState;
  createdAt: number; updatedAt: number; revision: number; errorCode?: string;
}
export interface VoiceCommitLedger {
  reserve(input: VoiceCommitInput): { record: VoiceCommitRecord; created: boolean };
  get(voiceTurnId: string, generation: number): VoiceCommitRecord | undefined;
  transition(voiceTurnId: string, generation: number, from: VoiceCommitState, to: VoiceCommitState, errorCode?: string, expectedRevision?: number): VoiceCommitRecord;
  claim(record: VoiceCommitRecord): { record: VoiceCommitRecord; claimed: boolean };
  deleteSession(sessionId: string): void;
  close(): void;
}

/** Stable, bounded reservations exist before any App Service side effect. A changed
 * text/model/session is a conflict, including after restart; failures never re-run. */
export class SqliteVoiceCommitLedger implements VoiceCommitLedger {
  private readonly database: DatabaseSync;
  private closed = false;
  constructor(filename: string, private readonly now: () => number = Date.now) {
    mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(filename);
    try {
      this.database.exec('PRAGMA busy_timeout = 5000;');
      // Independent component version avoids changing the asset store or Runtime schema.
      const existing = this.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='speech_voice_meta'").get();
      if (existing) {
        const version = this.database.prepare("SELECT value FROM speech_voice_meta WHERE key='schema_version'").get();
        if (version?.value !== '1') throw new Error('voice_commit_schema_unsupported');
      }
      this.database.exec(`PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS speech_voice_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT OR IGNORE INTO speech_voice_meta(key,value) VALUES ('schema_version','1');
        CREATE TABLE IF NOT EXISTS speech_voice_commits (
          voice_turn_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation >= 0),
          session_id TEXT NOT NULL, voice_session_id TEXT NOT NULL,
          run_id TEXT NOT NULL UNIQUE, lane_id TEXT NOT NULL CHECK(lane_id='main'),
          input_hash TEXT NOT NULL, text TEXT NOT NULL, provider_id TEXT NOT NULL, model TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('pending','submitting','committed','failed')),
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0), error_code TEXT,
          PRIMARY KEY(voice_turn_id,generation)
        );
        CREATE INDEX IF NOT EXISTS speech_voice_commits_session ON speech_voice_commits(session_id);
      `);
    } catch (error) { this.database.close(); throw error; }
  }
  private assertOpen(): void { if (this.closed) throw new Error('voice_commit_ledger_closed'); }
  get(voiceTurnId: string, generation: number): VoiceCommitRecord | undefined {
    this.assertOpen(); identifier.parse(voiceTurnId); z.number().int().nonnegative().parse(generation);
    const row = this.database.prepare('SELECT * FROM speech_voice_commits WHERE voice_turn_id=? AND generation=?').get(voiceTurnId, generation);
    if (!row) return undefined;
    return {
      ...VoiceCommitInputSchema.parse({ voiceSessionId: row.voice_session_id, voiceTurnId: row.voice_turn_id,
        sessionId: row.session_id, generation: row.generation, text: row.text, providerId: row.provider_id, model: row.model }),
      runId: String(row.run_id), laneId: 'main', inputHash: String(row.input_hash),
      state: z.enum(['pending','submitting','committed','failed']).parse(row.state),
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), revision: z.number().int().nonnegative().parse(row.revision),
      ...(typeof row.error_code === 'string' ? { errorCode: row.error_code } : {})
    };
  }
  reserve(input: VoiceCommitInput): { record: VoiceCommitRecord; created: boolean } {
    this.assertOpen(); input = VoiceCommitInputSchema.parse(input);
    const hash = createHash('sha256').update(JSON.stringify([input.voiceSessionId, input.sessionId, input.text, input.providerId, input.model, 'main'])).digest('hex');
    const now = this.now();
    const result = this.database.prepare(`INSERT OR IGNORE INTO speech_voice_commits
      (voice_turn_id,generation,session_id,voice_session_id,run_id,lane_id,input_hash,text,provider_id,model,state,created_at,updated_at)
      VALUES (?,?,?,?,?,'main',?,?,?,?,'pending',?,?)`)
      .run(input.voiceTurnId, input.generation, input.sessionId, input.voiceSessionId, randomUUID(), hash, input.text, input.providerId, input.model, now, now);
    const record = this.get(input.voiceTurnId, input.generation)!;
    if (record.inputHash !== hash) throw new Error('voice_commit_conflict');
    return { record, created: result.changes === 1 };
  }
  transition(voiceTurnId: string, generation: number, from: VoiceCommitState, to: VoiceCommitState, errorCode?: string, expectedRevision?: number): VoiceCommitRecord {
    this.assertOpen();
    const allowed = (from === 'pending' && (to === 'submitting' || to === 'failed')) ||
      (from === 'submitting' && (to === 'pending' || to === 'committed' || to === 'failed'));
    if (!allowed) throw new Error('voice_commit_invalid_transition');
    if (errorCode !== undefined && !/^[a-z][a-z0-9_]{0,127}$/u.test(errorCode)) throw new Error('voice_commit_invalid_error_code');
    const previous = this.get(voiceTurnId, generation);
    if (!previous) throw new Error('voice_commit_not_found');
    this.database.prepare(`UPDATE speech_voice_commits SET state=?,updated_at=?,error_code=?,revision=revision+1
      WHERE voice_turn_id=? AND generation=? AND state=? AND revision=?`)
      .run(to, this.now(), errorCode ?? null, voiceTurnId, generation, from, expectedRevision ?? previous.revision);
    const record = this.get(voiceTurnId, generation);
    if (!record) throw new Error('voice_commit_not_found');
    return record;
  }
  claim(record: VoiceCommitRecord): { record: VoiceCommitRecord; claimed: boolean } {
    this.assertOpen();
    const result = this.database.prepare(`UPDATE speech_voice_commits SET state='submitting',updated_at=?,error_code=NULL,revision=revision+1
      WHERE voice_turn_id=? AND generation=? AND state='pending' AND revision=? AND input_hash=?`)
      .run(this.now(), record.voiceTurnId, record.generation, record.revision, record.inputHash);
    const current = this.get(record.voiceTurnId, record.generation);
    if (!current) throw new Error('voice_commit_not_found');
    return { record: current, claimed: result.changes === 1 };
  }
  deleteSession(sessionId: string): void {
    this.assertOpen(); identifier.parse(sessionId);
    this.database.prepare('DELETE FROM speech_voice_commits WHERE session_id=?').run(sessionId);
  }
  close(): void { if (!this.closed) { this.database.close(); this.closed = true; } }
}
