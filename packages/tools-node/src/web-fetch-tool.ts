import type { Tool, ToolContext, ToolResult } from '@desktop-agent/contracts';
import { WebFetchInput } from './inputs.js';
import { htmlToMarkdown } from './web-html.js';
import { toolResult } from './tool-result.js';
import { UnsafeWebUrlError, assertSafeHttpUrl } from './web-url.js';

export const WEB_FETCH_MAX_BYTES = 512_000;
export const WEB_FETCH_TIMEOUT_MS = 30_000;
export const WEB_FETCH_MAX_REDIRECTS = 10;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export type WebHttpResponse = {
  status: number;
  headers: { get(name: string): string | null };
  url: string;
  arrayBuffer(): Promise<ArrayBuffer>;
};

export type WebHttpGet = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal; redirect: 'manual' }
) => Promise<WebHttpResponse>;

export class WebFetchTool implements Tool {
  readonly definition = {
    name: 'web_fetch',
    description: 'Fetch a public HTTP(S) URL and return text. HTML is converted to readable Markdown by default. Use this instead of the browser for ordinary documentation and public pages. JavaScript-rendered or login-walled content needs the browser tools. Binary responses are not returned.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', format: 'uri', description: 'HTTP or HTTPS URL to fetch.' },
        clean: { type: 'boolean', default: true, description: 'Convert HTML to Markdown. Set false to return the raw text body.' },
        referer: { type: 'string', description: 'Optional Referer header when a host requires it.' },
        userAgent: { type: 'string', description: 'Optional User-Agent override.' }
      },
      required: ['url'],
      additionalProperties: false
    }
  };

  constructor(
    private readonly httpGet: WebHttpGet = defaultHttpGet,
    private readonly maxBytes = WEB_FETCH_MAX_BYTES
  ) {}

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const parsed = WebFetchInput.parse(input);
    const timeout = AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS);
    const signal = context.signal.aborted ? context.signal : AbortSignal.any([context.signal, timeout]);
    try {
      const { finalUrl, status, contentType, body } = await this.fetchText(parsed.url, parsed, signal);
      if (status >= 400) {
        const preview = collapsePreview(body.toString('utf8'));
        return toolResult(false, `web_fetch: HTTP ${status} from ${finalUrl}${preview ? `: ${preview}` : '.'}`, { code: 'http_error' });
      }
      if (!isTextualContentType(contentType)) {
        return toolResult(true, `web_fetch: ${parsed.url} returned ${contentType || 'binary'} content. web_fetch only returns text; use browser_download for files, or browser tools for visual content.`);
      }
      const text = decodeBody(body, contentType);
      const cleaned = parsed.clean && isHtmlContentType(contentType) ? htmlToMarkdown(text, finalUrl) || text : text;
      const truncated = body.byteLength > this.maxBytes || Buffer.byteLength(cleaned) > this.maxBytes;
      const content = truncated ? `${cleaned.slice(0, this.maxBytes)}\n\n[truncated at ${this.maxBytes} bytes]` : cleaned;
      const header = `URL: ${finalUrl}\nStatus: ${status}\nContent-Type: ${contentType || 'unknown'}\n`;
      return toolResult(true, `${header}\n${content}`, truncated ? { truncated: true } : {});
    } catch (error) {
      if (context.signal.aborted) return toolResult(false, 'web_fetch cancelled.', { code: 'cancelled' });
      if (timeout.aborted) return toolResult(false, 'web_fetch timed out.', { code: 'timeout' });
      if (error instanceof UnsafeWebUrlError) return toolResult(false, error.message, { code: error.code });
      return toolResult(false, error instanceof Error ? error.message : String(error), { code: 'network' });
    }
  }

  private async fetchText(
    urlValue: string,
    input: { referer?: string | undefined; userAgent?: string | undefined },
    signal: AbortSignal
  ): Promise<{ finalUrl: string; status: number; contentType: string; body: Buffer }> {
    let current = await assertSafeHttpUrl(urlValue);
    for (let hop = 0; hop <= WEB_FETCH_MAX_REDIRECTS; hop += 1) {
      const referer = input.referer?.trim() || `${current.protocol}//${current.host}/`;
      const response = await this.httpGet(current.toString(), {
        redirect: 'manual',
        signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'User-Agent': input.userAgent?.trim() || DEFAULT_USER_AGENT,
          Referer: referer
        }
      });
      if (response.status >= 300 && response.status < 400) {
        await response.arrayBuffer().catch(() => undefined);
        const location = response.headers.get('location');
        if (!location) throw new Error(`Redirect from ${current.toString()} did not include a Location header.`);
        current = await assertSafeHttpUrl(new URL(location, current).toString());
        continue;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      return {
        finalUrl: response.url || current.toString(),
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        body: bytes.subarray(0, this.maxBytes + 1)
      };
    }
    throw new Error(`Stopped after ${WEB_FETCH_MAX_REDIRECTS} redirects.`);
  }
}

function defaultHttpGet(
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal; redirect: 'manual' }
): Promise<WebHttpResponse> {
  return fetch(url, init);
}

function isHtmlContentType(contentType: string): boolean {
  const type = mediaType(contentType);
  return type === '' || type === 'text/html' || type === 'application/xhtml+xml';
}

function isTextualContentType(contentType: string): boolean {
  const type = mediaType(contentType);
  if (!type) return true;
  if (type.startsWith('text/')) return true;
  if (type.endsWith('+json') || type.endsWith('+xml')) return true;
  return [
    'application/json', 'application/xml', 'application/javascript', 'application/xhtml+xml',
    'application/rss+xml', 'application/atom+xml', 'application/ld+json'
  ].includes(type);
}

function mediaType(contentType: string): string {
  return contentType.split(';')[0]?.trim().toLowerCase() ?? '';
}

function charsetFrom(contentType: string): string | undefined {
  const match = /charset\s*=\s*("?)([^";\s]+)\1/iu.exec(contentType);
  return match?.[2]?.trim();
}

function decodeBody(body: Buffer, contentType: string): string {
  const charset = charsetFrom(contentType) || charsetFromHtml(body) || 'utf-8';
  try {
    return new TextDecoder(charset, { fatal: false }).decode(body.subarray(0, WEB_FETCH_MAX_BYTES));
  } catch {
    return body.subarray(0, WEB_FETCH_MAX_BYTES).toString('utf8');
  }
}

function charsetFromHtml(body: Buffer): string | undefined {
  const head = body.subarray(0, 4_096).toString('latin1');
  const match = /<meta[^>]+charset\s*=\s*["']?([a-z0-9_-]+)/iu.exec(head)
    ?? /<meta[^>]+http-equiv=["']content-type["'][^>]+charset=([a-z0-9_-]+)/iu.exec(head);
  return match?.[1];
}

function collapsePreview(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().slice(0, 300);
}
