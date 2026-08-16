import crypto from 'node:crypto';
import http, { type IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export type ChromeCdpTransport = {
  send(data: string): void;
  close(): void;
};

function websocketAccept(key: string): string {
  return crypto.createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
}

export function encodeChromeCdpFrame(opcode: number, payload: Buffer, mask: boolean): Buffer {
  const length = payload.length;
  const lengthBytes = length < 126 ? 0 : length < 65_536 ? 2 : 8;
  const header = 2 + lengthBytes + (mask ? 4 : 0);
  const frame = Buffer.alloc(header + length);
  frame[0] = 0x80 | opcode;
  if (length < 126) frame[1] = (mask ? 0x80 : 0) | length;
  else if (length < 65_536) {
    frame[1] = (mask ? 0x80 : 0) | 126;
    frame.writeUInt16BE(length, 2);
  } else {
    frame[1] = (mask ? 0x80 : 0) | 127;
    frame.writeBigUInt64BE(BigInt(length), 2);
  }
  let offset = 2 + lengthBytes;
  if (mask) {
    const masking = crypto.randomBytes(4);
    masking.copy(frame, offset);
    offset += 4;
    for (let i = 0; i < length; i++) frame[offset + i] = payload[i]! ^ masking[i % 4]!;
  } else {
    payload.copy(frame, offset);
  }
  return frame;
}

export function consumeChromeCdpFrames(input: Buffer): {
  messages: string[];
  pings: Buffer[];
  rest: Buffer;
  closed: boolean;
} {
  const messages: string[] = [];
  const pings: Buffer[] = [];
  let offset = 0;
  let closed = false;
  while (input.length - offset >= 2) {
    const first = input[offset]!;
    const second = input[offset + 1]!;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let header = 2;
    if (length === 126) {
      if (input.length - offset < 4) break;
      length = input.readUInt16BE(offset + 2);
      header = 4;
    } else if (length === 127) {
      if (input.length - offset < 10) break;
      const size = input.readBigUInt64BE(offset + 2);
      if (size > 10_000_000n) throw new Error('Chrome debugger frame too large.');
      length = Number(size);
      header = 10;
    }
    const maskSize = masked ? 4 : 0;
    if (input.length - offset < header + maskSize + length) break;
    let payload = input.subarray(offset + header + maskSize, offset + header + maskSize + length);
    if (masked) {
      const mask = input.subarray(offset + header, offset + header + 4);
      const decoded = Buffer.alloc(length);
      for (let i = 0; i < length; i++) decoded[i] = payload[i]! ^ mask[i % 4]!;
      payload = decoded;
    }
    offset += header + maskSize + length;
    if (opcode === 0x1 || opcode === 0x0) messages.push(payload.toString('utf8'));
    else if (opcode === 0x8) closed = true;
    else if (opcode === 0x9) pings.push(Buffer.from(payload));
  }
  return { messages, pings, rest: input.subarray(offset), closed };
}

function httpUrlFromWebSocket(webSocketDebuggerUrl: string): URL {
  return new URL(webSocketDebuggerUrl.replace(/^wss:/u, 'https:').replace(/^ws:/u, 'http:'));
}

export function chromeCdpPortFromWebSocketUrl(webSocketDebuggerUrl: string): number {
  try {
    const target = httpUrlFromWebSocket(webSocketDebuggerUrl);
    return Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
  } catch {
    return 9222;
  }
}

export function connectChromeCdpSocket(
  webSocketDebuggerUrl: string,
  handlers: {
    onMessage: (data: string) => void;
    onClose: () => void;
    onError: (error: Error) => void;
  },
  timeoutMs = 8_000
): Promise<ChromeCdpTransport> {
  const target = httpUrlFromWebSocket(webSocketDebuggerUrl);
  const key = crypto.randomBytes(16).toString('base64');
  const expectedAccept = websocketAccept(key);
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = http.request({
      protocol: 'http:',
      hostname: target.hostname,
      port: Number(target.port) || 80,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      family: target.hostname === 'localhost' ? undefined : 4,
      agent: false,
      timeout: timeoutMs,
      headers: {
        Host: target.host,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        Origin: `http://${target.host}`,
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key
      }
    });
    request.setHeader('Connection', 'Upgrade');
    request.setHeader('Upgrade', 'websocket');
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      request.destroy();
      reject(error);
    };
    request.on('timeout', () => {
      fail(Object.assign(new Error('Timed out connecting to Chrome debugger.'), { code: 'ETIMEDOUT' }));
    });
    request.on('error', (error) => fail(error instanceof Error ? error : new Error(String(error))));
    request.on('response', (response) => {
      const status = response.statusCode ?? 0;
      response.resume();
      fail(new Error(
        status === 403
          ? 'Chrome rejected the debugger websocket. Start Chrome with --remote-allow-origins=*.'
          : `Chrome debugger websocket HTTP ${status}.`
      ));
    });
    request.on('upgrade', (response: IncomingMessage, socket, head) => {
      const accept = String(response.headers['sec-websocket-accept'] ?? '');
      if (accept !== expectedAccept) {
        socket.destroy();
        fail(new Error('Chrome debugger websocket handshake failed.'));
        return;
      }
      if (settled) {
        socket.destroy();
        return;
      }
      settled = true;
      request.setTimeout(0);
      resolve(bindChromeCdpSocket(socket, head, handlers));
    });
    request.end();
  });
}

function bindChromeCdpSocket(
  socket: Socket,
  head: Buffer,
  handlers: {
    onMessage: (data: string) => void;
    onClose: () => void;
    onError: (error: Error) => void;
  }
): ChromeCdpTransport {
  socket.setNoDelay(true);
  let buffer = head.length ? Buffer.from(head) : Buffer.alloc(0);
  let closed = false;
  const close = (error?: Error) => {
    if (closed) return;
    closed = true;
    socket.removeAllListeners();
    socket.destroy();
    if (error) handlers.onError(error);
    handlers.onClose();
  };
  socket.on('data', (chunk) => {
    try {
      buffer = Buffer.concat([buffer, chunk]);
      const parsed = consumeChromeCdpFrames(buffer);
      buffer = parsed.rest;
      for (const ping of parsed.pings) socket.write(encodeChromeCdpFrame(0xa, ping, true));
      for (const message of parsed.messages) handlers.onMessage(message);
      if (parsed.closed) close();
    } catch (error) {
      close(error instanceof Error ? error : new Error(String(error)));
    }
  });
  socket.on('error', (error) => close(error));
  socket.on('close', () => close());
  socket.resume();
  return {
    send: (data: string) => {
      if (closed) throw new Error('Chrome debugger connection is closed.');
      socket.write(encodeChromeCdpFrame(0x1, Buffer.from(data, 'utf8'), true));
    },
    close: () => close()
  };
}
