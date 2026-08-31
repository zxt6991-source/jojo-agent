function escapeHtml(text: string): string {
  return text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

/** A deliberately small, safe Markdown subset accepted by Telegram HTML mode. */
export function telegramMarkdownHtml(markdown: string): string {
  const placeholders: string[] = [];
  const protectedText = markdown.replace(/```(?:\w+)?\n([\s\S]*?)```/gu, (_match, code: string) => {
    const index = placeholders.push(`<pre><code>${escapeHtml(code)}</code></pre>`) - 1;
    return `\uE000${index}\uE001`;
  }).replace(/`([^`\n]+)`/gu, (_match, code: string) => {
    const index = placeholders.push(`<code>${escapeHtml(code)}</code>`) - 1;
    return `\uE000${index}\uE001`;
  });
  let html = escapeHtml(protectedText)
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/gu, '<a href="$2">$1</a>')
    .replace(/\*\*([^*\n]+)\*\*/gu, '<b>$1</b>')
    .replace(/__([^_\n]+)__/gu, '<b>$1</b>')
    .replace(/~~([^~\n]+)~~/gu, '<s>$1</s>')
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/gu, '$1<i>$2</i>');
  html = html.replace(/\uE000(\d+)\uE001/gu, (_match, index: string) => placeholders[Number(index)] ?? '');
  return html;
}

export function safeTelegramFilename(value: string | undefined, fallback: string): string {
  const basename = (value ?? fallback).split(/[\\/]/u).pop() ?? fallback;
  const safe = basename.replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/^\.+/u, '').slice(0, 180);
  return safe || fallback;
}
