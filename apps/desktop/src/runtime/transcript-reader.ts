import type { Message } from '@desktop-agent/contracts';
import type { SqliteAgentRuntimeStore } from '@desktop-agent/storage';

/** UI and export read immutable Runtime facts, including history before compaction. */
export async function readRuntimeMessages(store: SqliteAgentRuntimeStore, sessionId: string): Promise<Message[]> {
  return store.readConversationMessages(sessionId);
}
