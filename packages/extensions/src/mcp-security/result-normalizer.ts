import type { CallToolResult, ContentBlock as McpContentBlock } from '@modelcontextprotocol/client';
import type { ToolResult, ToolResultContentBlock } from '@desktop-agent/contracts';

export type McpResultLimits = {
  maxBlocks: number;
  maxTextBlockBytes: number;
  maxImageBytes: number;
  maxStructuredBytes: number;
  maxTotalBytes: number;
};

export const DEFAULT_MCP_RESULT_LIMITS: McpResultLimits = {
  maxBlocks: 100,
  maxTextBlockBytes: 256 * 1024,
  maxImageBytes: 5 * 1024 * 1024,
  maxStructuredBytes: 512 * 1024,
  maxTotalBytes: 1_500_000
};

function utf8Bytes(value: string): number { return Buffer.byteLength(value, 'utf8'); }

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (utf8Bytes(value) <= maxBytes) return { value, truncated: false };
  let low = 0;
  let high = Math.min(value.length, Math.max(0, maxBytes));
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Bytes(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return { value: value.slice(0, low), truncated: true };
}

function boundedJson(value: unknown, maxBytes: number): string {
  let remaining = maxBytes;
  const seen = new WeakSet<object>();
  const visit = (current: unknown, depth: number): unknown => {
    if (remaining <= 0) return '[truncated]';
    if (typeof current === 'string') {
      const bounded = truncateUtf8(current, Math.min(remaining, 64 * 1024));
      remaining -= utf8Bytes(bounded.value);
      return bounded.value + (bounded.truncated ? '[truncated]' : '');
    }
    if (current === null || typeof current === 'number' || typeof current === 'boolean') return current;
    if (typeof current !== 'object') return String(current);
    if (depth >= 8) return '[max depth]';
    if (seen.has(current)) return '[circular]';
    seen.add(current);
    if (Array.isArray(current)) {
      const output: unknown[] = [];
      for (let index = 0; index < current.length && index < 1_000 && remaining > 0; index += 1) {
        remaining -= 4;
        output.push(visit(current[index], depth + 1));
      }
      return output;
    }
    const output: Record<string, unknown> = {};
    let count = 0;
    for (const key in current) {
      if (count >= 1_000) break;
      if (!Object.prototype.hasOwnProperty.call(current, key)) continue;
      remaining -= utf8Bytes(key) + 4;
      if (remaining <= 0) break;
      output[key] = visit((current as Record<string, unknown>)[key], depth + 1);
      count += 1;
    }
    return output;
  };
  try { return truncateUtf8(JSON.stringify(visit(value, 0), null, 2), maxBytes).value; }
  catch { return '[unserializable MCP content]'; }
}

export class McpResultNormalizer {
  constructor(private readonly limits: McpResultLimits = DEFAULT_MCP_RESULT_LIMITS) {}

  normalize(result: Pick<CallToolResult, 'content' | 'structuredContent' | 'isError'>): ToolResult {
    const contentBlocks: ToolResultContentBlock[] = [];
    let blockBytes = 0;
    let truncated = result.content.length > this.limits.maxBlocks;
    const textBudget = Math.floor(this.limits.maxTotalBytes / 2);

    const addText = (raw: string, perBlockLimit = this.limits.maxTextBlockBytes): void => {
      if (contentBlocks.length >= this.limits.maxBlocks || blockBytes >= textBudget) { truncated = true; return; }
      const available = Math.min(perBlockLimit, textBudget - blockBytes);
      const bounded = truncateUtf8(raw, available);
      contentBlocks.push({ type: 'text', text: bounded.value });
      blockBytes += utf8Bytes(bounded.value);
      truncated ||= bounded.truncated;
    };
    const addImage = (data: string, mimeType: string, altText?: string): void => {
      if (contentBlocks.length >= this.limits.maxBlocks) { truncated = true; return; }
      const decodedBytes = Math.floor(data.length * 3 / 4);
      const serializedBytes = utf8Bytes(data) + utf8Bytes(mimeType) + (altText ? utf8Bytes(altText) : 0);
      if (decodedBytes > this.limits.maxImageBytes || blockBytes + serializedBytes > this.limits.maxTotalBytes) {
        truncated = true;
        addText(`[image omitted: ${mimeType}, ${decodedBytes} bytes]`);
        return;
      }
      contentBlocks.push({ type: 'image', data, mimeType, ...(altText ? { altText: truncateUtf8(altText, 2_000).value } : {}) });
      blockBytes += serializedBytes;
    };

    for (const block of result.content.slice(0, this.limits.maxBlocks)) this.addBlock(block, addText, addImage);
    if (result.structuredContent !== undefined) addText(boundedJson(result.structuredContent, this.limits.maxStructuredBytes), this.limits.maxStructuredBytes);

    let content = contentBlocks.map((block) => block.type === 'text'
      ? block.text
      : `[image attached: ${block.mimeType}${block.altText ? `, ${block.altText}` : ''}]`
    ).filter(Boolean).join('\n') || '(MCP tool returned no content)';
    const remaining = Math.max(0, this.limits.maxTotalBytes - blockBytes - 1_024);
    const boundedContent = truncateUtf8(content, remaining);
    content = boundedContent.value;
    truncated ||= boundedContent.truncated;
    if (truncated) content = `${content}\n[MCP result truncated]`;
    return {
      callId: '', ok: result.isError !== true, content, contentBlocks,
      ...(truncated ? { truncated: true } : {}),
      ...(result.isError === true ? { code: 'mcp_tool_error' } : {})
    };
  }

  private addBlock(
    block: McpContentBlock,
    addText: (text: string) => void,
    addImage: (data: string, mimeType: string, altText?: string) => void
  ): void {
    if (block.type === 'text') addText(block.text);
    else if (block.type === 'resource_link') addText(`[resource ${block.name}: ${block.uri}]`);
    else if (block.type === 'resource') {
      const resource = block.resource;
      if ('text' in resource) addText(resource.text);
      else if (resource.mimeType?.startsWith('image/')) addImage(resource.blob, resource.mimeType, resource.uri);
      else addText(`[binary resource: ${resource.uri}]`);
    } else if (block.type === 'image') addImage(block.data, block.mimeType);
    else if (block.type === 'audio') addText(`[audio omitted: ${block.mimeType}, ${block.data.length} base64 characters]`);
    else addText(boundedJson(block, this.limits.maxTextBlockBytes));
  }
}
