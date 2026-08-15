const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'
]);
const DROP_SUBTREES = new Set(['script', 'style', 'noscript', 'svg', 'template', 'iframe', 'object', 'canvas']);
const DROP_CHROME = new Set(['nav', 'footer', 'aside', 'form']);
const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'main', 'header', 'ul', 'ol', 'li', 'table', 'tr', 'blockquote',
  'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'figure', 'figcaption', 'dt', 'dd'
]);

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;|&#160;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&apos;|&#39;/giu, "'")
    .replace(/&mdash;/giu, '—')
    .replace(/&ndash;/giu, '–')
    .replace(/&hellip;/giu, '…')
    .replace(/&#x([0-9a-f]+);/giu, (_match, hex: string) => codePointToChar(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_match, dec: string) => codePointToChar(Number.parseInt(dec, 10)));
}

export function stripHtml(value: string): string {
  return collapseWhitespace(decodeHtmlEntities(value.replace(/<[^>]+>/gu, ' ')));
}

export function htmlToMarkdown(html: string, baseUrl?: string): string {
  const title = stripHtml((/<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html) ?? [])[1] ?? '');
  const cleaned = stripSubtrees(html, DROP_SUBTREES);
  const extracted = extractTag(cleaned, 'article') ?? extractTag(cleaned, 'main');
  let body = convertFragment(extracted ?? cleaned, baseUrl);
  if (visibleLength(body) < 200) body = convertFragment(cleaned, baseUrl);
  body = collapseBlankLines(body).trim();
  if (title && !body.toLocaleLowerCase().includes(title.toLocaleLowerCase().slice(0, Math.min(40, title.length)))) {
    body = `# ${title}${body ? `\n\n${body}` : ''}`;
  }
  return body;
}

export function parseDuckDuckGoHtml(body: string, max: number): WebSearchHit[] {
  const links = [...body.matchAll(/<a[^>]*class="result__a"[^>]*href="\/\/duckduckgo\.com\/l\/\?uddg=([^"&]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/giu)];
  const snippets = [...body.matchAll(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/giu)];
  const hits: WebSearchHit[] = [];
  for (const [index, match] of links.entries()) {
    if (hits.length >= max) break;
    const encoded = match[1];
    if (!encoded) continue;
    let url: string;
    try { url = decodeURIComponent(encoded); }
    catch { continue; }
    if (!url) continue;
    hits.push({
      title: stripHtml(match[2] ?? ''),
      url,
      snippet: stripHtml(snippets[index]?.[1] ?? '')
    });
  }
  return hits;
}

export function parseDuckDuckGoLiteHtml(body: string, max: number): WebSearchHit[] {
  const hits: WebSearchHit[] = [];
  for (const match of body.matchAll(/<a[^>]*rel="nofollow"[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/giu)) {
    if (hits.length >= max) break;
    const url = match[1];
    if (!url || url.includes('duckduckgo.com')) continue;
    hits.push({ title: stripHtml(match[2] ?? ''), url, snippet: '' });
  }
  return hits;
}

export function parseBingHtml(body: string, max: number): WebSearchHit[] {
  const blocks = [...body.matchAll(/<li[^>]*class="b_algo"[^>]*>([\s\S]*?)<\/li>/giu)];
  const hits: WebSearchHit[] = [];
  for (const block of blocks) {
    if (hits.length >= max) break;
    const titleMatch = /<h2[^>]*>[\s\S]*?<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/iu.exec(block[1] ?? '');
    if (!titleMatch?.[1]) continue;
    const snippetMatch = /<p[^>]*class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/iu.exec(block[1] ?? '')
      ?? /<div[^>]*class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/iu.exec(block[1] ?? '');
    hits.push({
      title: stripHtml(titleMatch[2] ?? ''),
      url: decodeBingTrackingUrl(titleMatch[1]),
      snippet: stripHtml(snippetMatch?.[1] ?? '')
    });
  }
  return hits;
}

export function decodeBingTrackingUrl(wrapped: string): string {
  if (!wrapped.includes('bing.com/ck/')) return wrapped;
  let parsed: URL;
  try { parsed = new URL(wrapped); }
  catch { return wrapped; }
  const value = parsed.searchParams.get('u') ?? '';
  if (!value.startsWith('a1')) return wrapped;
  const payload = value.slice(2);
  const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
  try {
    const decoded = Buffer.from(padded, 'base64url').toString('utf8');
    return decoded.startsWith('http') ? decoded : wrapped;
  } catch {
    return wrapped;
  }
}

export type WebSearchHit = {
  title: string;
  url: string;
  snippet: string;
};

function codePointToChar(code: number): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
  return String.fromCodePoint(code);
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function collapseBlankLines(value: string): string {
  return value.replace(/[ \t]+\n/gu, '\n').replace(/\n{3,}/gu, '\n\n');
}

function visibleLength(value: string): number {
  return value.replace(/\s+/gu, '').length;
}

function stripSubtrees(html: string, tags: Set<string>): string {
  let output = '';
  let index = 0;
  let skipDepth = 0;
  let skipTag = '';
  while (index < html.length) {
    if (html.startsWith('<!--', index)) {
      const end = html.indexOf('-->', index + 4);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html[index] !== '<') {
      const next = html.indexOf('<', index);
      const end = next === -1 ? html.length : next;
      if (skipDepth === 0) output += html.slice(index, end);
      index = end;
      continue;
    }
    const gt = html.indexOf('>', index + 1);
    if (gt === -1) break;
    const raw = html.slice(index + 1, gt).trim();
    const closing = raw.startsWith('/');
    const name = (closing ? raw.slice(1) : raw).split(/[\s/]/u)[0]?.toLowerCase() ?? '';
    const selfClosing = !closing && (raw.endsWith('/') || VOID_TAGS.has(name));
    if (skipDepth > 0) {
      if (!closing && name === skipTag && !selfClosing) skipDepth += 1;
      else if (closing && name === skipTag) {
        skipDepth -= 1;
        if (skipDepth === 0) skipTag = '';
      }
      index = gt + 1;
      continue;
    }
    if (!closing && tags.has(name)) {
      if (!selfClosing) {
        skipDepth = 1;
        skipTag = name;
      }
      index = gt + 1;
      continue;
    }
    output += html.slice(index, gt + 1);
    index = gt + 1;
  }
  return output;
}

function extractTag(html: string, tag: string): string | undefined {
  const open = new RegExp(`<${tag}\\b[^>]*>`, 'iu').exec(html);
  if (!open) return undefined;
  const close = new RegExp(`</${tag}\\s*>`, 'iu');
  close.lastIndex = open.index + open[0].length;
  const end = close.exec(html);
  return html.slice(open.index, end ? end.index + end[0].length : html.length);
}

function convertFragment(html: string, baseUrl: string | undefined, skipChrome = true): string {
  let markdown = '';
  let skipDepth = 0;
  let skipTag = '';
  let inPre = 0;
  const pending = { href: '', text: '' };
  const token = /<\/?([a-zA-Z][a-zA-Z0-9:-]*)([^>]*)>|([^<]+)/gu;
  let match: RegExpExecArray | null;
  while ((match = token.exec(html))) {
    if (match[3] !== undefined) {
      if (skipDepth > 0) continue;
      const text = inPre > 0 ? decodeHtmlEntities(match[3]) : collapseWhitespace(decodeHtmlEntities(match[3]));
      if (!text) continue;
      if (pending.href) pending.text += (pending.text && inPre === 0 ? ' ' : '') + text;
      else markdown += text;
      continue;
    }
    const name = match[1]!.toLowerCase();
    const closing = match[0].startsWith('</');
    const attrs = parseAttrs(match[2] ?? '');
    const selfClosing = !closing && (match[0].endsWith('/>') || VOID_TAGS.has(name));
    if (skipDepth > 0) {
      if (!closing && name === skipTag && !selfClosing) skipDepth += 1;
      else if (closing && name === skipTag) {
        skipDepth -= 1;
        if (skipDepth === 0) skipTag = '';
      }
      continue;
    }
    if (!closing && skipChrome && DROP_CHROME.has(name) && !selfClosing) {
      skipDepth = 1;
      skipTag = name;
      continue;
    }
    if (name === 'br' || name === 'hr') {
      markdown += '\n';
      continue;
    }
    if (name === 'pre') {
      if (closing) {
        inPre = Math.max(0, inPre - 1);
        markdown += '\n```\n';
      } else {
        inPre += 1;
        markdown += '\n```\n';
      }
      continue;
    }
    if (name === 'code' && inPre === 0) {
      markdown += '`';
      continue;
    }
    if (name === 'a') {
      if (closing) {
        const href = absolutize(pending.href, baseUrl);
        const label = collapseWhitespace(pending.text) || href;
        markdown += href ? `[${label}](${href})` : label;
        pending.href = '';
        pending.text = '';
      } else {
        pending.href = attrs.href ?? '';
        pending.text = '';
      }
      continue;
    }
    if (name === 'li') {
      markdown += closing ? '\n' : '\n- ';
      continue;
    }
    if (/^h[1-6]$/u.test(name)) {
      markdown += closing ? '\n\n' : `\n\n${'#'.repeat(Number(name[1]))} `;
      continue;
    }
    if (name === 'blockquote') {
      markdown += closing ? '\n' : '\n> ';
      continue;
    }
    if (name === 'strong' || name === 'b') {
      markdown += '**';
      continue;
    }
    if (name === 'em' || name === 'i') {
      markdown += '*';
      continue;
    }
    if (BLOCK_TAGS.has(name)) {
      markdown += closing ? '\n\n' : '\n\n';
    }
  }
  if (pending.text) markdown += pending.href ? `[${collapseWhitespace(pending.text)}](${absolutize(pending.href, baseUrl)})` : pending.text;
  return markdown;
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const token = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/gu;
  let match: RegExpExecArray | null;
  while ((match = token.exec(raw))) {
    attrs[match[1]!.toLowerCase()] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

function absolutize(href: string, baseUrl: string | undefined): string {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith('#') || /^(javascript|data|vbscript):/iu.test(trimmed)) return '';
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return trimmed;
  }
}
