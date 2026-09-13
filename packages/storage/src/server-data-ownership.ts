import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const held = new WeakSet<ServerDataOwnership>();

/** A separate SQLite write transaction is an OS-backed lifetime lock, released even on SIGKILL. */
export class ServerDataOwnership {
  private released = false;
  private constructor(readonly dataDir: string, private readonly database: DatabaseSync) { held.add(this); }

  static acquire(dataDir: string): ServerDataOwnership {
    mkdirSync(dataDir, { recursive: true });
    const canonical = realpathSync(dataDir);
    const database = new DatabaseSync(path.join(canonical, '.server-ownership.sqlite'));
    try {
      database.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE');
      return new ServerDataOwnership(canonical, database);
    } catch (cause) {
      database.close();
      throw new Error('server_data_directory_busy', { cause });
    }
  }

  static assertHeld(ownership: ServerDataOwnership, dataDir: string): void {
    if (!held.has(ownership) || ownership.released || ownership.dataDir !== realpathSync(dataDir)) throw new Error('server_data_ownership_required');
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    held.delete(this);
    this.database.close();
  }
}
