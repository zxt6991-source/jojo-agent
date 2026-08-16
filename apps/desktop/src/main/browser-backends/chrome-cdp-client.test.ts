import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  ChromeCdpClient,
  chromeCdpOrigin,
  chromeCdpUnavailableMessage,
  chromeDebugLaunchHint,
  listChromeTargets,
  probeChromeCdp,
  rethrowChromeCdpError
} from './chrome-cdp-client';
import { consumeChromeCdpFrames, encodeChromeCdpFrame } from './chrome-cdp-socket';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function listen(handler?: http.RequestListener): Promise<{ port: number; server: http.Server; close: () => Promise<void> }> {
  const server = handler ? http.createServer(handler) : http.createServer();
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        server,
        close: () => new Promise((done, fail) => {
          server.closeAllConnections();
          server.close((error) => error ? fail(error) : done());
        })
      });
    });
    server.on('error', reject);
  });
}

describe('chrome cdp probe helpers', () => {
  it('reads version and tab lists from injected debug HTTP endpoints', async () => {
    expect(chromeCdpOrigin(9222)).toBe('http://127.0.0.1:9222');
    const httpGet = async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => url.endsWith('/json/version')
        ? { browser: 'Chrome/124', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc' }
        : [{ id: 't1', type: 'page', title: 'GitHub', url: 'https://github.com/' }],
      text: async () => ''
    });
    await expect(probeChromeCdp(9222, '127.0.0.1', httpGet)).resolves.toMatchObject({ browser: 'Chrome/124' });
    await expect(listChromeTargets(9222, '127.0.0.1', httpGet)).resolves.toEqual([
      { id: 't1', type: 'page', title: 'GitHub', url: 'https://github.com/' }
    ]);
  });

  it('probes a local debug-like HTTP server with the default client', async () => {
    const server = await listen((request, response) => {
      if (request.url === '/json/version') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          browser: 'Chrome/Test',
          webSocketDebuggerUrl: 'ws://127.0.0.1:0/devtools/browser/x'
        }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    try {
      await expect(probeChromeCdp(server.port)).resolves.toMatchObject({ browser: 'Chrome/Test' });
    } finally {
      await server.close();
    }
  });

  it('explains a refused debug port instead of fetch failed', async () => {
    const server = await listen((_request, response) => {
      response.writeHead(204);
      response.end();
    });
    const { port } = server;
    await server.close();
    await expect(probeChromeCdp(port)).rejects.toThrow(chromeCdpUnavailableMessage(port));
    expect(() => rethrowChromeCdpError(Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' }), 9222))
      .toThrow(/未在 127.0.0.1:9222 发现 Chrome/u);
    expect(chromeDebugLaunchHint(9222)).toContain('--remote-debugging-port=9222');
    expect(chromeDebugLaunchHint(9222)).toContain('--user-data-dir=');
  });
});

describe('chrome cdp websocket client', () => {
  it('round-trips masked text frames', () => {
    const frame = encodeChromeCdpFrame(0x1, Buffer.from('{"id":1}'), true);
    expect(consumeChromeCdpFrames(frame).messages).toEqual(['{"id":1}']);
  });

  it('exchanges a CDP command over a node websocket', async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(426, { Connection: 'close' });
      response.end();
    });
    server.on('upgrade', (request, socket) => {
      const key = String(request.headers['sec-websocket-key'] ?? '');
      const accept = crypto.createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
      );
      let buffer = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        const parsed = consumeChromeCdpFrames(buffer);
        buffer = parsed.rest;
        for (const message of parsed.messages) {
          const payload = JSON.parse(message) as { id: number };
          socket.write(encodeChromeCdpFrame(0x1, Buffer.from(JSON.stringify({ id: payload.id, result: { ok: true } })), false));
        }
      });
      socket.resume();
    });
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve());
      server.on('error', reject);
    });
    const port = (server.address() as AddressInfo).port;
    const client = await ChromeCdpClient.connect(`ws://127.0.0.1:${port}/devtools/page/1`);
    try {
      await expect(client.send('Page.enable')).resolves.toEqual({ ok: true });
    } finally {
      client.close();
      server.closeAllConnections();
      server.close();
    }
  });

  it('maps a refused websocket to the Chrome unavailable message', async () => {
    const server = await listen();
    const { port } = server;
    await server.close();
    await expect(ChromeCdpClient.connect(`ws://127.0.0.1:${port}/devtools/page/1`))
      .rejects.toThrow(chromeCdpUnavailableMessage(port));
  });
});
