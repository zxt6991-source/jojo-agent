import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DefaultPermissionGate,
  GrepTool,
  ReadFileTool,
  WebFetchTool,
  WebSearchTool,
  buildWebFetchOutline,
  cleanupExpiredWebFetchFiles,
  htmlToMarkdown,
  isBlockedFetchAddress,
  parseBingHtml,
  parseDuckDuckGoHtml,
  parseHttpUrl,
  previewWebFetchContent,
  spillWebFetchContent,
  webFetchSpillDirectory
} from '../src/index.js';

const context = (options: { signal?: AbortSignal; workingDirectory?: string } = {}) => ({
  sessionId: 's1',
  workingDirectory: options.workingDirectory ?? os.tmpdir(),
  approved: false,
  signal: options.signal ?? new AbortController().signal,
  onProgress: () => undefined
});

function call(name: string, input: unknown) {
  return { id: 'c1', name, input };
}

async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (origin: string) => Promise<void>
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe('web url safety', () => {
  it('accepts credential-free HTTP(S) and blocks metadata addresses', () => {
    expect(parseHttpUrl('https://example.com/docs').hostname).toBe('example.com');
    expect(() => parseHttpUrl('javascript:alert(1)')).toThrow(/HTTP and HTTPS/u);
    expect(() => parseHttpUrl('https://user:secret@example.com/')).toThrow(/credentials/u);
    expect(isBlockedFetchAddress('169.254.169.254')).toBe(true);
    expect(isBlockedFetchAddress('::ffff:169.254.169.254')).toBe(true);
    expect(isBlockedFetchAddress('127.0.0.1')).toBe(false);
    expect(isBlockedFetchAddress('10.0.0.8')).toBe(false);
  });
});

describe('web html helpers', () => {
  it('converts the main article to markdown and drops scripts', () => {
    const markdown = htmlToMarkdown(`
      <html><head><title>Guide</title></head>
      <body>
        <nav>Home</nav>
        <script>alert(1)</script>
        <article>
          <h1>Install</h1>
          <p>Run <code>pnpm test</code> and read the <a href="/docs">docs</a>.</p>
        </article>
      </body></html>
    `, 'https://example.com/start');
    expect(markdown).toContain('# Install');
    expect(markdown).toContain('`pnpm test`');
    expect(markdown).toContain('[docs](https://example.com/docs)');
    expect(markdown).not.toContain('alert(1)');
    expect(markdown).not.toContain('Home');
  });

  it('parses DuckDuckGo and Bing result HTML', () => {
    expect(parseDuckDuckGoHtml(`
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage">Example</a>
      <a class="result__snippet">A public page</a>
    `, 5)).toEqual([{ title: 'Example', url: 'https://example.com/page', snippet: 'A public page' }]);
    expect(parseBingHtml(`
      <li class="b_algo">
        <h2><a href="https://cn.bing.com/ck/a?u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS8">Example</a></h2>
        <p class="b_lineclamp2">Snippet</p>
      </li>
    `, 5)[0]).toMatchObject({ title: 'Example', snippet: 'Snippet', url: 'https://example.com/' });
  });
});

describe('web permission gate', () => {
  it('allows search and public fetch, and rejects unsafe fetch URLs', async () => {
    const gate = new DefaultPermissionGate();
    await expect(gate.check(call('web_search', { query: 'zod schema' }), { sessionId: 's1', workingDirectory: os.tmpdir() }))
      .resolves.toEqual({ decision: 'allow' });
    await expect(gate.check(call('web_fetch', { url: 'https://example.com/docs' }), { sessionId: 's1', workingDirectory: os.tmpdir() }))
      .resolves.toEqual({ decision: 'allow' });
    await expect(gate.check(call('web_fetch', { url: 'javascript:alert(1)' }), { sessionId: 's1', workingDirectory: os.tmpdir() }))
      .resolves.toMatchObject({ decision: 'deny', code: 'unsafe_url' });
    await expect(gate.check(call('web_search', { query: '' }), { sessionId: 's1', workingDirectory: os.tmpdir() }))
      .resolves.toMatchObject({ decision: 'deny', code: 'invalid_input' });
  });
});

describe('web_fetch', () => {
  it('returns cleaned HTML from a local server', async () => {
    await withServer((_request, response) => {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<html><article><h1>Hello</h1><p>Public docs.</p></article></html>');
    }, async (origin) => {
      const result = await new WebFetchTool().execute({ url: `${origin}/docs` }, context());
      expect(result.ok).toBe(true);
      expect(result.content).toContain('URL: ');
      expect(result.content).toContain('# Hello');
      expect(result.content).toContain('Public docs.');
      expect(result.content).not.toContain('Full content saved to:');
    });
  });

  it('spills large pages to a temp file with outline and preview', async () => {
      const body = `<html><article><h1>Heading One</h1><h2>Installation</h2><p>${'Large documentation paragraph. '.repeat(80)}</p></article></html>`;
    await withServer((_request, response) => {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(body);
    }, async (origin) => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), 'jojo-web-fetch-ws-'));
      const result = await new WebFetchTool(undefined, 5_000_000, 200).execute({ url: `${origin}/rfc` }, context({ workingDirectory: workspace }));
      expect(result.ok).toBe(true);
      expect(result.truncated).toBe(true);
      expect(result.content).toContain('Content is too large to return inline.');
      expect(result.content).toMatch(/Outline:\n- # /u);
      expect(result.content).toContain('Full content saved to:');
      const savedPath = /Full content saved to:\n(.+)$/mu.exec(result.content)?.[1]?.trim();
      expect(savedPath).toBeTruthy();
      const read = await new ReadFileTool().execute({ path: savedPath }, context({ workingDirectory: workspace }));
      expect(read.ok).toBe(true);
      expect(read.content).toContain('Heading One');
      await expect(new DefaultPermissionGate().check(call('read_file', { path: savedPath }), { sessionId: 's1', workingDirectory: workspace }))
        .resolves.toEqual({ decision: 'allow' });
      await expect(new DefaultPermissionGate().check(call('grep', { query: 'Heading One', path: savedPath }), { sessionId: 's1', workingDirectory: workspace }))
        .resolves.toEqual({ decision: 'allow' });
      const grep = await new GrepTool().execute({ query: 'Heading One', path: savedPath }, context({ workingDirectory: workspace }));
      expect(grep.ok).toBe(true);
      expect(grep.content).toContain('Heading One');
    });
  });

  it('builds an outline, preview, and expires old spill files', async () => {
    expect(buildWebFetchOutline('# Intro\n\ntext\n## Install\n\n## Config')).toEqual(['# Intro', '## Install', '## Config']);
    expect(previewWebFetchContent('a\nb\nc\nd', 2)).toBe('a\nb');
    const saved = await spillWebFetchContent('# Saved', 'https://example.com/docs');
    expect(saved.startsWith(webFetchSpillDirectory())).toBe(true);
    expect(await cleanupExpiredWebFetchFiles(Date.now() + 48 * 60 * 60 * 1000)).toBeGreaterThan(0);
  });

  it('does not dump binary bodies and blocks metadata IPs and redirects', async () => {
    const blocked = await new WebFetchTool().execute({ url: 'http://169.254.169.254/' }, context());
    expect(blocked).toMatchObject({ ok: false, code: 'unsafe_url' });

    await withServer((_request, response) => {
      response.statusCode = 302;
      response.setHeader('Location', 'http://169.254.169.254/secret');
      response.end();
    }, async (origin) => {
      const result = await new WebFetchTool().execute({ url: origin }, context());
      expect(result).toMatchObject({ ok: false, code: 'unsafe_url' });
    });

    await withServer((_request, response) => {
      response.setHeader('Content-Type', 'application/pdf');
      response.end('%PDF-fake');
    }, async (origin) => {
      const result = await new WebFetchTool().execute({ url: origin }, context());
      expect(result.ok).toBe(true);
      expect(result.content).toContain('application/pdf');
      expect(result.content).not.toContain('%PDF-fake');
    });
  });
});

describe('web_search', () => {
  it('uses the first backend that returns hits and falls through on empty results', async () => {
    const tool = new WebSearchTool([
      { name: 'empty', search: async () => [] },
      {
        name: 'ok',
        search: async () => [{ title: 'Zod', url: 'https://zod.dev/', snippet: 'TypeScript schema' }]
      }
    ]);
    const result = await tool.execute({ query: 'zod', maxResults: 3 }, context());
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.content)).toMatchObject({
      query: 'zod',
      provider: 'ok',
      count: 1,
      results: [{ title: 'Zod', url: 'https://zod.dev/' }]
    });
  });
});
