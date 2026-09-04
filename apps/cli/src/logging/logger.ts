import { mkdirSync } from 'node:fs';
import { Writable } from 'node:stream';
import pino, { type DestinationStream, type Logger } from 'pino';
import type { EffectiveConfig } from '../config/schema.js';

const REDACT_PATHS = [
  'authorization', 'cookie', 'set-cookie', 'token', 'accessToken', 'refreshToken',
  'apiKey', 'secret', 'appSecret', 'verificationToken', 'encryptKey', 'password',
  '*.authorization', '*.cookie', '*.set-cookie', '*.token', '*.accessToken', '*.refreshToken',
  '*.apiKey', '*.secret', '*.appSecret', '*.verificationToken', '*.encryptKey', '*.password',
  'req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie'
];

export function createLogger(config: EffectiveConfig): Logger {
  const destination = createDestination(config);
  return pino({
    level: config.logging.level,
    base: {
      service: 'jojo',
      instanceId: config.runtime.instanceId,
      version: '0.1.0',
      pid: process.pid
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    serializers: {
      error: pino.stdSerializers.err,
      err: pino.stdSerializers.err
    }
  }, destination);
}

export async function flushLogger(logger: Logger): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    logger.flush((error?: Error) => error ? reject(error) : resolve());
  });
}

function createDestination(config: EffectiveConfig): DestinationStream {
  if (config.logging.file) {
    mkdirSync(config.paths.logDir, { recursive: true, mode: 0o700 });
    const destination = pino.destination({ dest: config.logging.file, mkdir: true, sync: true });
    return config.logging.format === 'pretty' ? new PrettyStream(destination) : destination;
  }
  return config.logging.format === 'pretty' ? new PrettyStream(process.stdout) : process.stdout;
}

class PrettyStream extends Writable {
  private buffer = '';

  constructor(private readonly target: { write(chunk: string): unknown }) {
    super();
  }

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.buffer += chunk.toString();
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line) continue;
      this.target.write(`${formatPrettyLine(line)}\n`);
    }
    callback();
  }
}

function formatPrettyLine(line: string): string {
  try {
    const record = JSON.parse(line) as Record<string, unknown>;
    const time = typeof record.time === 'string' ? record.time.slice(11, 19) : '--:--:--';
    const level = levelName(record.level).padEnd(5);
    const event = typeof record.event === 'string'
      ? record.event
      : typeof record.msg === 'string' ? record.msg : 'log';
    const omitted = new Set(['level', 'time', 'service', 'instanceId', 'version', 'pid', 'component', 'event', 'msg']);
    const fields = Object.entries(record)
      .filter(([key]) => !omitted.has(key))
      .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
      .join(' ');
    const component = typeof record.component === 'string' ? ` ${record.component}` : '';
    return `${time} ${level}${component} ${event}${fields ? ` ${fields}` : ''}`;
  } catch {
    return line;
  }
}

function levelName(level: unknown): string {
  if (typeof level !== 'number') return 'INFO';
  if (level >= 60) return 'FATAL';
  if (level >= 50) return 'ERROR';
  if (level >= 40) return 'WARN';
  if (level >= 30) return 'INFO';
  if (level >= 20) return 'DEBUG';
  return 'TRACE';
}
