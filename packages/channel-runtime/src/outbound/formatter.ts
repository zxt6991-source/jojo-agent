import type { ChannelCapabilities, ChannelContentBlock } from '@desktop-agent/channel-core';
import { chunkChannelText } from './chunker.js';

function plainMarkdown(text: string): string {
  return text.replace(/```[^\n]*\n?/gu, '').replace(/```/gu, '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/gu, '$1 ($2)')
    .replace(/(^|\s)[*_~]{1,2}([^*_~]+)[*_~]{1,2}(?=\s|$)/gu, '$1$2');
}

export function formatChannelContent(
  content: ChannelContentBlock[],
  capabilities: ChannelCapabilities
): ChannelContentBlock[][] {
  const downgraded: ChannelContentBlock[] = [];
  for (const block of content) {
    if (block.type === 'markdown' && !capabilities.outbound.markdown) {
      downgraded.push({ type: 'text', text: plainMarkdown(block.text) });
    } else if (block.type === 'actions' && !capabilities.outbound.buttons) {
      downgraded.push({
        type: 'text',
        text: block.buttons.map((button) => `${button.label}: /action ${button.actionToken}`).join('\n')
      });
    } else if ((block.type === 'image' && !capabilities.outbound.image)
      || (block.type === 'file' && !capabilities.outbound.file)) {
      const label = block.type === 'file' ? block.name : block.alt ?? 'image';
      downgraded.push({ type: 'text', text: `[Unsupported attachment: ${label}]` });
    } else {
      downgraded.push(block);
    }
  }

  const limit = capabilities.limits.maxTextChars;
  if (!limit) return [downgraded];
  const messages: ChannelContentBlock[][] = [[]];
  for (const block of downgraded) {
    if (block.type !== 'text' && block.type !== 'markdown') {
      messages.at(-1)!.push(block);
      continue;
    }
    const pieces = chunkChannelText(block.text, limit, block.type === 'markdown');
    for (const piece of pieces) {
      const current = messages.at(-1)!;
      if (current.length > 0) messages.push([]);
      messages.at(-1)!.push({ ...block, text: piece });
    }
  }
  return messages.filter((message) => message.length > 0);
}
