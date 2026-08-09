import type { ToolResult } from '@desktop-agent/contracts';

export function toolResult(
  ok: boolean,
  content: string,
  options: { truncated?: boolean; code?: string } = {}
): ToolResult {
  return {
    callId: '',
    ok,
    content,
    ...(options.truncated ? { truncated: true } : {}),
    ...(options.code ? { code: options.code } : {})
  };
}
