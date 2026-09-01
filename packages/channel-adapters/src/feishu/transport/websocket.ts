import * as Lark from '@larksuiteoapi/node-sdk';

export type FeishuWsConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

export interface FeishuWsClient {
  start(input: { eventDispatcher: unknown }): Promise<void>;
  close(options?: { force?: boolean }): void;
  getConnectionStatus?(): { state: FeishuWsConnectionState; reconnectAttempts?: number };
}

export type FeishuWsClientOptions = {
  appId: string;
  appSecret: string;
  handshakeTimeoutMs: number;
  pingTimeoutSeconds: number;
  onReady(): void;
  onError(error: Error): void;
  onReconnecting(): void;
  onReconnected(): void;
};

export type FeishuWsClientFactory = (options: FeishuWsClientOptions) => FeishuWsClient;

export interface FeishuWebSocketTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type FeishuWebSocketTransportOptions = {
  appId: string;
  appSecret: string;
  handshakeTimeoutMs: number;
  pingTimeoutSeconds: number;
  createWsClient?: FeishuWsClientFactory;
  onEvent(type: 'im.message.receive_v1' | 'card.action.trigger', payload: unknown): void | Promise<void>;
  onReady(): void;
  onReconnecting(): void;
  onReconnected(): void;
  onError(error: Error): void;
  onEventError?(error: Error): void;
};

type FeishuEventDispatcher = {
  register(handlers: Record<string, (payload: unknown) => unknown>): FeishuEventDispatcher;
};

export class DefaultFeishuWebSocketTransport implements FeishuWebSocketTransport {
  private client: FeishuWsClient | undefined;
  private startPromise: Promise<void> | undefined;
  private rejectFirstReady: ((error: Error) => void) | undefined;
  private stopped = false;

  constructor(private readonly options: FeishuWebSocketTransportOptions) {}

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.stopped = false;
    this.startPromise = this.open();
    return this.startPromise;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.rejectFirstReady?.(new Error('feishu_ws_closed'));
    this.rejectFirstReady = undefined;
    this.client?.close({ force: true });
    this.client = undefined;
  }

  private async open(): Promise<void> {
    if (!/^cli_[0-9a-fA-F]{16}$/u.test(this.options.appId)) {
      throw new Error('feishu_ws_invalid_app_id');
    }

    let settled = false;
    let resolveFirstReady!: () => void;
    const firstReady = new Promise<void>((resolve, reject) => {
      resolveFirstReady = () => {
        if (settled) return;
        settled = true;
        this.rejectFirstReady = undefined;
        resolve();
      };
      this.rejectFirstReady = (error) => {
        if (settled) return;
        settled = true;
        this.rejectFirstReady = undefined;
        reject(error);
      };
    });

    const createWsClient = this.options.createWsClient ?? createDefaultFeishuWsClient;
    this.client = createWsClient({
      appId: this.options.appId,
      appSecret: this.options.appSecret,
      handshakeTimeoutMs: this.options.handshakeTimeoutMs,
      pingTimeoutSeconds: this.options.pingTimeoutSeconds,
      onReady: () => {
        if (this.stopped) return;
        this.options.onReady();
        resolveFirstReady();
      },
      onReconnecting: () => {
        if (this.stopped) return;
        this.options.onReconnecting();
      },
      onReconnected: () => {
        if (this.stopped) return;
        this.options.onReconnected();
      },
      onError: (error) => {
        if (this.stopped) return;
        if (!settled) this.rejectFirstReady?.(error);
        else this.options.onError(error);
      }
    });

    const dispatch = (type: 'im.message.receive_v1' | 'card.action.trigger', payload: unknown): void => {
      void Promise.resolve()
        .then(() => this.options.onEvent(type, payload))
        .catch((error: unknown) => this.options.onEventError?.(toError(error)));
    };
    const dispatcher = new Lark.EventDispatcher({ loggerLevel: Lark.LoggerLevel.error }) as FeishuEventDispatcher;
    dispatcher.register({
      'im.message.receive_v1': (payload) => {
        dispatch('im.message.receive_v1', payload);
      },
      'card.action.trigger': (payload) => {
        dispatch('card.action.trigger', payload);
        return { toast: { type: 'info', content: '请求已收到' } };
      }
    });

    try {
      await this.client.start({ eventDispatcher: dispatcher });
      await firstReady;
    } catch (error) {
      this.client?.close({ force: true });
      this.client = undefined;
      throw toError(error);
    }
  }
}

export function createDefaultFeishuWsClient(options: FeishuWsClientOptions): FeishuWsClient {
  const client = new Lark.WSClient({
    appId: options.appId,
    appSecret: options.appSecret,
    autoReconnect: true,
    handshakeTimeoutMs: options.handshakeTimeoutMs,
    wsConfig: { pingTimeout: options.pingTimeoutSeconds },
    loggerLevel: Lark.LoggerLevel.error,
    onReady: options.onReady,
    onError: options.onError,
    onReconnecting: options.onReconnecting,
    onReconnected: options.onReconnected
  });
  return {
    start: ({ eventDispatcher }) => client.start({ eventDispatcher: eventDispatcher as Lark.EventDispatcher }),
    close: (closeOptions) => client.close(closeOptions),
    getConnectionStatus: () => client.getConnectionStatus()
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
