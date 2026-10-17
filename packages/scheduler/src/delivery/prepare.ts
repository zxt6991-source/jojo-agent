import { ScheduleDeliveryItemSchema, type ResultContentPort } from '@desktop-agent/contracts';
import type { ScheduleDeliveryItem, ScheduleRun } from '../types.js';

const RESULT_FALLBACK = '任务已完成，请查看结果。';

function take(text: string, limit: number): string {
  const part = text.slice(0, limit);
  return /[\uD800-\uDBFF]$/u.test(part) ? part.slice(0, -1) : part;
}

/** Scheduler fixes readable text before persisting an intent; it never reads tool events. */
export function readableScheduleText(text: string, limit = 600): string {
  const readable = text.normalize('NFC')
    .replace(/```[^\n]*\n?[\s\S]*?```/gu, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/https?:\/\/[^\s<>]+/gu, ' ')
    .replace(/^\s*\|.*\|\s*$/gmu, ' ')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gmu, '')
    .replace(/[*_`~]/gu, '').replace(/\s+/gu, ' ').trim();
  return take(readable, limit);
}

export type PrepareScheduleDeliveriesOptions = {
  resultContent?: ResultContentPort;
  idGenerator?: () => string;
  contentReadTimeoutMs?: number;
  voicePresetVersion?: (presetId?: string) => string;
};

async function committedContent(run: ScheduleRun, options: PrepareScheduleDeliveriesOptions): Promise<{ text: string; reason?: string }> {
  if (run.status === 'failed' || run.status === 'interrupted') {
    return { text: `“${run.deliverySnapshot?.name ?? '任务'}”未完成，请查看运行记录。` };
  }
  if (run.targetSnapshot.kind === 'reminder') return { text: run.targetSnapshot.text.trim() };
  if (!options.resultContent || !run.targetExecutionId) return { text: RESULT_FALLBACK, reason: 'schedule_result_unavailable' };
  let cancelTimeout: (() => void) | undefined;
  try {
    const text = await Promise.race([
      options.resultContent.readCommittedResult({ targetKind: run.targetSnapshot.kind, executionId: run.targetExecutionId }),
      new Promise<undefined>((resolve) => {
        const timer = setTimeout(resolve, options.contentReadTimeoutMs ?? 5_000);
        cancelTimeout = () => clearTimeout(timer);
      })
    ]);
    return text?.trim()
      ? { text: take(text.trim(), 100_000) }
      : { text: RESULT_FALLBACK, reason: 'schedule_result_unavailable' };
  } catch {
    return { text: RESULT_FALLBACK, reason: 'schedule_result_read_failed' };
  } finally {
    cancelTimeout?.();
  }
}

/** Missing legacy snapshots are intentionally silent: current destinations cannot be substituted. */
export async function prepareScheduleDeliveries(
  run: ScheduleRun, options: PrepareScheduleDeliveriesOptions = {}
): Promise<ScheduleDeliveryItem[]> {
  if (!['completed', 'failed', 'interrupted'].includes(run.status) || !run.deliverySnapshot?.delivery) return [];
  const delivery = run.deliverySnapshot.delivery;
  const { text, reason } = await committedContent(run, options);
  const createdAt = run.finishedAt ?? run.createdAt;
  const title = take(run.deliverySnapshot.name, 256);
  const nextId = options.idGenerator ?? (() => crypto.randomUUID());
  const items: ScheduleDeliveryItem[] = [];
  const append = (destination: ScheduleDeliveryItem['destination'], destinationId: string, content: string,
    extra: Record<string, unknown> = {}, expiresAt?: string) => {
    const id = `sd_${nextId()}`;
    const messageId = destination === 'conversation' && run.id.length <= 246 ? `scheduler_${run.id}` : id;
    items.push(ScheduleDeliveryItemSchema.parse({
      id, scheduleRunId: run.id, destination, destinationId,
      dedupeKey: `schedule:${run.id}:${destination}:${destinationId}`,
      payloadSnapshot: { kind: destination, title, content, createdAt, messageId, ...extra },
      state: 'pending', attempts: 0, createdAt, updatedAt: createdAt, version: 1,
      ...(expiresAt ? { expiresAt } : {}),
      ...(reason ? { errorCode: reason } : {})
    }));
  };
  if (delivery.conversation?.enabled) append('conversation', delivery.conversation.sessionId, text);
  if (delivery.notification?.enabled) append('notification', 'local-desktop', readableScheduleText(text, 4_096) || RESULT_FALLBACK);
  for (const channel of delivery.channels ?? []) {
    if (channel.enabled) append('channel', channel.bindingId,
      channel.mode === 'preview' ? take(text, 500) : text,
      channel.mode ? { mode: channel.mode } : {});
  }
  if (delivery.voice?.enabled) {
    const voice = delivery.voice;
    const source = run.status === 'completed' && voice.content.kind === 'fixed' ? voice.content.text : text;
    const limit = voice.content.kind === 'result' ? Math.min(600, voice.content.maxChars) : 600;
    const expiryBase = run.targetSnapshot.kind === 'reminder' ? run.scheduledFor : createdAt;
    append('voice', voice.deviceId, readableScheduleText(source, limit) || RESULT_FALLBACK, {
      deviceId: voice.deviceId, ...(voice.presetId ? { presetId: voice.presetId } : {}),
      ...(options.voicePresetVersion ? { presetVersion: options.voicePresetVersion(voice.presetId) } : {})
    }, new Date(new Date(expiryBase).getTime() + voice.expiresAfterMs).toISOString());
  }
  return items;
}
