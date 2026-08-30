import {
  ClientHelloSchema,
  CreateScheduleInputSchema,
  ErrorResponseSchema,
  JOJO_SERVER_PROTOCOL_VERSION,
  RunSnapshotSchema,
  ScheduleRunSchema,
  ScheduleSchema,
  ServerCapabilitiesSchema,
  ServerInfoSchema,
  ServerSessionSnapshotSchema,
  ServerSessionSummarySchema,
  ServerWireMessageSchema,
  TranscriptPageSchema,
  type ClientCommand,
  type CreateScheduleInput,
  type CreateSessionInput,
  type LeaseMode,
  type LeaseSnapshot,
  type PatchSessionMetadataInput,
  type ProtocolError,
  type RunResult,
  type RunSnapshot,
  type Schedule,
  type ScheduleEvent,
  type ScheduleRun,
  type ScheduleRunListQuery,
  type ServerCapabilities,
  type ServerInfo,
  type ServerSessionSnapshot,
  type ServerSessionSummary,
  type ServerWireMessage,
  type StartRunInput,
  type TranscriptPage,
  type TranscriptQuery,
  type UpdateScheduleInput
} from '@desktop-agent/server-protocol';
import type { ZodType } from 'zod';

export type JojoClientOptions = {
  baseUrl: string;
  token?: string;
  clientId?: string;
  clientName?: string;
  clientVersion?: string;
  reconnect?: boolean;
  runPollIntervalMs?: number;
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
};

export type RunInput = Omit<StartRunInput, 'input'> & {
  input: StartRunInput['input'] | string;
};

export type SessionEventListener = (message: Extract<ServerWireMessage, { type: 'event' }>) => void;
export type RunEventListener = SessionEventListener;
export type ScheduleEventListener = (event: ScheduleEvent) => void;

export class JojoClientError extends Error {
  constructor(readonly protocol: ProtocolError) {
    super(protocol.message);
    this.name = 'JojoClientError';
  }
}

type PendingCommand = {
  resolve(value: unknown): void;
  reject(error: unknown): void;
};

export class JojoClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly WebSocketImpl: typeof WebSocket;
  private readonly clientId: string;
  private readonly sessions = new Map<string, JojoSession>();
  private readonly pending = new Map<string, PendingCommand>();
  private readonly scheduleListeners = new Set<ScheduleEventListener>();
  private socket: WebSocket | undefined;
  private connectPromise: Promise<void> | undefined;
  private manuallyClosed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempts = 0;
  private _connectionId: string | undefined;

  constructor(readonly options: JojoClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/u, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.WebSocketImpl = options.WebSocket ?? globalThis.WebSocket;
    this.clientId = options.clientId ?? `client_${crypto.randomUUID()}`;
    if (!this.fetchImpl) throw new Error('fetch_unavailable');
    if (!this.WebSocketImpl) throw new Error('websocket_unavailable');
  }

  get connectionId(): string | undefined { return this._connectionId; }

  connect(): Promise<void> {
    if (this.socket?.readyState === this.WebSocketImpl.OPEN) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    this.manuallyClosed = false;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const socket = new this.WebSocketImpl(this.wsUrl());
      this.socket = socket;
      let welcomed = false;
      socket.addEventListener('open', () => {
        const hello = ClientHelloSchema.parse({
          type: 'hello',
          version: JOJO_SERVER_PROTOCOL_VERSION,
          ...(this.options.token ? { auth: { type: 'bearer', token: this.options.token } } : {}),
          client: {
            id: this.clientId,
            name: this.options.clientName ?? '@desktop-agent/client',
            version: this.options.clientVersion ?? '0.1.0'
          }
        });
        socket.send(JSON.stringify(hello));
      });
      socket.addEventListener('message', (event) => {
        try {
          const message = ServerWireMessageSchema.parse(JSON.parse(String(event.data)));
          if (message.type === 'hello') {
            welcomed = true;
            this._connectionId = message.connectionId;
            this.reconnectAttempts = 0;
            this.connectPromise = undefined;
            resolve();
            return;
          }
          if (message.type === 'hello_error') {
            const error = new JojoClientError(message.error);
            this.connectPromise = undefined;
            reject(error);
            socket.close();
            return;
          }
          this.onMessage(message);
        } catch (error) {
          if (!welcomed) reject(error);
        }
      });
      socket.addEventListener('error', () => {
        if (!welcomed) {
          this.connectPromise = undefined;
          reject(new Error('websocket_connection_failed'));
        }
      });
      socket.addEventListener('close', () => {
        if (this.socket !== socket) return;
        this._connectionId = undefined;
        this.socket = undefined;
        this.connectPromise = undefined;
        for (const pending of this.pending.values()) pending.reject(new Error('websocket_disconnected'));
        this.pending.clear();
        if (!this.manuallyClosed && this.options.reconnect !== false) this.scheduleReconnect();
      });
    });
    return this.connectPromise;
  }

  async reconnect(): Promise<void> {
    const previous = this.socket;
    if (previous) {
      this.socket = undefined;
      previous.close();
    }
    this.connectPromise = undefined;
    await this.connect();
    await Promise.all([...this.sessions.values()].map((session) => session.reattach()));
  }

  async close(): Promise<void> {
    this.manuallyClosed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.socket?.close(1000, 'client_closed');
    this.socket = undefined;
    this._connectionId = undefined;
  }

  getServerInfo(): Promise<ServerInfo> {
    return this.http('/api/v1/server', ServerInfoSchema);
  }

  getCapabilities(): Promise<ServerCapabilities> {
    return this.http('/api/v1/capabilities', ServerCapabilitiesSchema);
  }

  listSessions(): Promise<ServerSessionSummary[]> {
    return this.http('/api/v1/sessions', ServerSessionSummarySchema.array());
  }

  async createSession(input: CreateSessionInput): Promise<JojoSession> {
    const snapshot = await this.http('/api/v1/sessions', ServerSessionSnapshotSchema, {
      method: 'POST', body: input, idempotencyKey: crypto.randomUUID()
    });
    return this.session(snapshot.id);
  }

  async getSession(sessionId: string): Promise<JojoSession> {
    await this.http(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, ServerSessionSnapshotSchema);
    return this.session(sessionId);
  }

  async resolveApproval(approvalId: string, decision: 'allow' | 'deny'): Promise<void> {
    await this.http(`/api/v1/approvals/${encodeURIComponent(approvalId)}/resolve`, undefined, {
      method: 'POST', body: { decision }, idempotencyKey: crypto.randomUUID()
    });
  }

  listSchedules(): Promise<Schedule[]> {
    return this.http('/api/v1/schedules', ScheduleSchema.array());
  }

  createSchedule(input: CreateScheduleInput): Promise<Schedule> {
    return this.http('/api/v1/schedules', ScheduleSchema, {
      method: 'POST', body: CreateScheduleInputSchema.parse(input), idempotencyKey: crypto.randomUUID()
    });
  }

  getSchedule(scheduleId: string): Promise<Schedule> {
    return this.http(`/api/v1/schedules/${encodeURIComponent(scheduleId)}`, ScheduleSchema);
  }

  updateSchedule(scheduleId: string, input: UpdateScheduleInput): Promise<Schedule> {
    return this.http(`/api/v1/schedules/${encodeURIComponent(scheduleId)}`, ScheduleSchema, {
      method: 'PATCH', body: input, idempotencyKey: crypto.randomUUID()
    });
  }

  async deleteSchedule(scheduleId: string): Promise<void> {
    await this.http(`/api/v1/schedules/${encodeURIComponent(scheduleId)}`, undefined, {
      method: 'DELETE', idempotencyKey: crypto.randomUUID()
    });
  }

  runScheduleNow(scheduleId: string, options: { respectConcurrency?: boolean } = {}): Promise<ScheduleRun> {
    return this.http(`/api/v1/schedules/${encodeURIComponent(scheduleId)}/run`, ScheduleRunSchema, {
      method: 'POST', body: options, idempotencyKey: crypto.randomUUID()
    });
  }

  listScheduleRuns(scheduleId: string, query: Partial<ScheduleRunListQuery> = {}): Promise<ScheduleRun[]> {
    const params = new URLSearchParams();
    if (query.states?.length) params.set('states', query.states.join(','));
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    const suffix = params.size ? `?${params.toString()}` : '';
    return this.http(
      `/api/v1/schedules/${encodeURIComponent(scheduleId)}/runs${suffix}`,
      ScheduleRunSchema.array()
    );
  }

  getScheduleRun(runId: string): Promise<ScheduleRun> {
    return this.http(`/api/v1/schedule-runs/${encodeURIComponent(runId)}`, ScheduleRunSchema);
  }

  async cancelScheduleRun(runId: string): Promise<void> {
    await this.http(`/api/v1/schedule-runs/${encodeURIComponent(runId)}/cancel`, undefined, {
      method: 'POST', idempotencyKey: crypto.randomUUID()
    });
  }

  subscribeSchedules(listener: ScheduleEventListener): () => void {
    this.scheduleListeners.add(listener);
    return () => this.scheduleListeners.delete(listener);
  }

  command(command: ClientCommand): Promise<unknown> {
    if (!this.socket || this.socket.readyState !== this.WebSocketImpl.OPEN || !this._connectionId) {
      throw new Error('client_not_connected');
    }
    return new Promise((resolve, reject) => {
      this.pending.set(command.id, { resolve, reject });
      this.socket!.send(JSON.stringify(command));
    });
  }

  async http<T>(path: string, schema: ZodType<T> | undefined, options: {
    method?: string;
    body?: unknown;
    idempotencyKey?: string;
  } = {}): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.options.token) headers.authorization = `Bearer ${this.options.token}`;
    if (this._connectionId) headers['x-jojo-connection-id'] = this._connectionId;
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
    });
    if (!response.ok) {
      const parsed = ErrorResponseSchema.safeParse(await response.json().catch(() => undefined));
      throw new JojoClientError(parsed.success
        ? parsed.data.error
        : { code: 'http_error', message: `HTTP ${response.status}` });
    }
    if (response.status === 204 || !schema) return undefined as T;
    return schema.parse(await response.json());
  }

  private session(id: string): JojoSession {
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const session = new JojoSession(this, id);
    this.sessions.set(id, session);
    return session;
  }

  private onMessage(message: ServerWireMessage): void {
    if (message.type === 'response') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new JojoClientError(message.error));
      return;
    }
    if (message.type === 'schedule.event') {
      for (const listener of this.scheduleListeners) listener(message.event);
      return;
    }
    if (message.type === 'event') this.sessions.get(message.sessionId)?.emit(message);
  }

  private wsUrl(): string {
    const url = new URL(this.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = `${url.pathname.replace(/\/$/u, '')}/api/v1/events`;
    url.search = '';
    return url.toString();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(10_000, 250 * 2 ** this.reconnectAttempts++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.reconnect().catch(() => this.scheduleReconnect());
    }, delay);
  }
}

export class JojoSession {
  private readonly listeners = new Set<SessionEventListener>();
  private mode: LeaseMode | undefined;

  constructor(private readonly client: JojoClient, readonly id: string) {}

  async attach(mode: LeaseMode = 'observe'): Promise<LeaseSnapshot> {
    await this.client.connect();
    const result = await this.client.command({
      type: 'session.attach',
      id: crypto.randomUUID(),
      input: { sessionId: this.id, mode }
    });
    this.mode = mode;
    return result as LeaseSnapshot;
  }

  async detach(): Promise<void> {
    if (!this.mode) return;
    await this.client.command({ type: 'session.detach', id: crypto.randomUUID(), sessionId: this.id });
    this.mode = undefined;
  }

  snapshot(): Promise<ServerSessionSnapshot> {
    return this.client.http(`/api/v1/sessions/${encodeURIComponent(this.id)}`, ServerSessionSnapshotSchema);
  }

  async patch(input: PatchSessionMetadataInput): Promise<ServerSessionSnapshot> {
    if (this.mode !== 'control') await this.attach('control');
    return this.client.http(
      `/api/v1/sessions/${encodeURIComponent(this.id)}`,
      ServerSessionSnapshotSchema,
      { method: 'PATCH', body: input, idempotencyKey: crypto.randomUUID() }
    );
  }

  transcript(options: Partial<TranscriptQuery> = {}): Promise<TranscriptPage> {
    const query = new URLSearchParams();
    if (options.laneId) query.set('laneId', options.laneId);
    if (options.cursor) query.set('cursor', options.cursor);
    if (options.limit) query.set('limit', String(options.limit));
    const suffix = query.size ? `?${query.toString()}` : '';
    return this.client.http(`/api/v1/sessions/${encodeURIComponent(this.id)}/transcript${suffix}`, TranscriptPageSchema);
  }

  async run(input: RunInput): Promise<JojoRun> {
    if (this.mode !== 'control') await this.attach('control');
    const normalized: StartRunInput = {
      ...input,
      input: typeof input.input === 'string'
        ? { content: [{ type: 'text', text: input.input }] }
        : input.input
    };
    const snapshot = await this.client.http(
      `/api/v1/sessions/${encodeURIComponent(this.id)}/runs`,
      RunSnapshotSchema,
      { method: 'POST', body: normalized, idempotencyKey: crypto.randomUUID() }
    );
    return new JojoRun(this.client, this, snapshot.id);
  }

  subscribe(listener: SessionEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(message: Extract<ServerWireMessage, { type: 'event' }>): void {
    for (const listener of this.listeners) {
      try { listener(message); } catch { /* SDK listeners are isolated. */ }
    }
  }

  async reattach(): Promise<void> {
    if (!this.mode) return;
    const mode = this.mode;
    this.mode = undefined;
    try { await this.attach(mode); }
    catch (error) {
      this.mode = mode;
      throw error;
    }
  }
}

export class JojoRun {
  constructor(
    private readonly client: JojoClient,
    private readonly session: JojoSession,
    readonly id: string
  ) {}

  snapshot(): Promise<RunSnapshot> {
    return this.client.http(
      `/api/v1/sessions/${encodeURIComponent(this.session.id)}/runs/${encodeURIComponent(this.id)}`,
      RunSnapshotSchema
    );
  }

  async cancel(reason?: string): Promise<void> {
    await this.client.http(
      `/api/v1/sessions/${encodeURIComponent(this.session.id)}/runs/${encodeURIComponent(this.id)}/cancel`,
      undefined,
      { method: 'POST', body: reason ? { reason } : {} }
    );
  }

  subscribe(listener: RunEventListener): () => void {
    return this.session.subscribe((message) => {
      if (message.event.runId === this.id) listener(message);
    });
  }

  async result(): Promise<RunResult> {
    return new Promise<RunResult>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let done = false;
      const finish = (work: () => void) => {
        if (done) return;
        done = true;
        unsubscribe();
        if (timer) clearTimeout(timer);
        work();
      };
      const check = async () => {
        try {
          const snapshot = await this.snapshot();
          if (snapshot.result && ['completed', 'failed', 'cancelled'].includes(snapshot.status)) {
            finish(() => resolve(snapshot.result!));
            return;
          }
          if (snapshot.status === 'interrupted') {
            finish(() => reject(new JojoClientError(snapshot.error ?? {
              code: 'runtime_interrupted', message: 'Runtime execution was interrupted.'
            })));
            return;
          }
        } catch (error) {
          if (error instanceof JojoClientError && error.protocol.code !== 'runtime_unavailable') {
            finish(() => reject(error));
            return;
          }
        }
        timer = setTimeout(check, this.client.options.runPollIntervalMs ?? 250);
      };
      const unsubscribe = this.subscribe(() => { void check(); });
      void check();
    });
  }
}
