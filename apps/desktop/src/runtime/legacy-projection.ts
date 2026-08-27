import type { Message } from '@desktop-agent/contracts';
import type { AgentRuntimeStore } from '@desktop-agent/agent-runtime/spi';

/**
 * One-way migration adapter for the Renderer JSONL store. Runtime storage is
 * authoritative; this projection can be deleted once the Renderer reads
 * Runtime session snapshots directly.
 */
export async function seedRuntimeLaneFromLegacy(
  runtimeStore: AgentRuntimeStore,
  sessionId: string,
  messages: Message[]
): Promise<void> {
  let lane = await runtimeStore.getLane(sessionId, 'main');
  if (!lane) throw new Error(`runtime_lane_not_found: main`);
  if (lane.leafId !== null) return;
  for (const message of messages) {
    if (!await runtimeStore.getEntry(message.id)) {
      await runtimeStore.appendEntry({
        id: message.id,
        sessionId,
        parentId: lane.leafId,
        type: 'message',
        message
      });
    }
    lane = { ...lane, leafId: message.id };
    await runtimeStore.saveLane(lane);
  }
}

export async function projectRuntimeMessagesToLegacy(
  messages: Message[],
  commit: (message: Message) => Promise<void>
): Promise<void> {
  for (const message of messages) await commit(message);
}
