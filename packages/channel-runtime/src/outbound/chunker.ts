function hardChunks(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < Math.floor(limit * 0.5)) cut = rest.lastIndexOf(' ', limit);
    if (cut < Math.floor(limit * 0.5)) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** Paragraph-first chunking with fenced-code continuity for markdown transports. */
export function chunkChannelText(text: string, limit: number, markdown = false): string[] {
  if (!Number.isSafeInteger(limit) || limit < 64) throw new Error('channel_invalid_text_limit');
  if (text.length <= limit) return [text];
  const output: string[] = [];
  let current = '';
  for (const paragraph of text.split(/(\n{2,})/u)) {
    if ((current + paragraph).length <= limit) { current += paragraph; continue; }
    if (current.trim()) output.push(current.trimEnd());
    if (paragraph.length <= limit) current = paragraph.trimStart();
    else {
      const pieces = hardChunks(paragraph, markdown ? limit - 8 : limit);
      output.push(...pieces.slice(0, -1));
      current = pieces.at(-1) ?? '';
    }
  }
  if (current.trim()) output.push(current.trimEnd());
  if (!markdown) return output;

  let fenceOpen = false;
  return output.map((chunk, index) => {
    const prefix = fenceOpen ? '```\n' : '';
    const fences = (chunk.match(/```/gu) ?? []).length;
    if (fences % 2 === 1) fenceOpen = !fenceOpen;
    const suffix = fenceOpen && index < output.length - 1 ? '\n```' : '';
    return `${prefix}${chunk}${suffix}`;
  });
}
