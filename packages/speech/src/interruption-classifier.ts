export type InterruptionDecision = 'true' | 'backchannel' | 'false' | 'pending';
const normalize = (text: string) => text.normalize('NFC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '');
const BACKCHANNEL = new Set(['嗯', '嗯嗯', '哦', '噢', '对', '对对', '好', '好的', '是', '是的', '啊', 'okay', 'ok', 'yeah', 'yes', 'uhhuh']);
export function isVoiceBackchannel(text: string): boolean { return BACKCHANNEL.has(normalize(text)); }
/** Partial acknowledgements are never final decisions: “好” can continue as
 * “好，但先停一下”. No classifier result grants permission to cancel a Run. */
export function classifyInterruption(text: string, final: boolean): InterruptionDecision {
  const value = normalize(text);
  if (!value) return final ? 'false' : 'pending';
  if (/^(?:等等|等一下|先停|停一下|别说|不是这个|不对|我问的是|取消任务|停止这个任务|取消操作|stop|wait|holdon)/u.test(value)) return 'true';
  if (!final) return 'pending';
  if (isVoiceBackchannel(value)) return 'backchannel';
  return /[\p{L}\p{N}]/u.test(value) ? 'true' : 'false';
}
