import { timingSafeEqual } from 'node:crypto';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  LogController
} from 'fastify';
import websocket from '@fastify/websocket';
import { z, type ZodType } from 'zod';
import type { ChannelWebhookRequest, ChannelWebhookResponse } from '@desktop-agent/channel-core';
import { asProtocolError, ProtocolFailure, protocolStatus, type JojoServerCore } from '@desktop-agent/server-core';
import {
  ClientCommandSchema,
  ClientHelloSchema,
  ApproveChannelPairingInputSchema,
  ChannelDeliveryListQuerySchema,
  ChannelPairingListQuerySchema,
  CreateChannelBindingInputSchema,
  CreateChannelInstanceInputSchema,
  CreateScheduleInputSchema,
  CreateSessionInputSchema,
  JOJO_SERVER_PROTOCOL_VERSION,
  PatchSessionMetadataInputSchema,
  ResolveApprovalInputSchema,
  RunScheduleNowInputSchema,
  ScheduleRunListQuerySchema,
  StartRunInputSchema,
  TestChannelInputSchema,
  TranscriptQuerySchema,
  UpdateScheduleInputSchema,
  UpdateChannelBindingInputSchema,
  UpdateChannelInstanceInputSchema,
  type Principal,
  type RequestContext,
  type ServerWireMessage
} from '@desktop-agent/server-protocol';

export type JojoHttpServerOptions = {
  host?: string;
  port?: number;
  token?: string;
  allowRemote?: boolean;
  bodyLimit?: number;
  maxWebSocketPayloadBytes?: number;
  maxPendingBytes?: number;
  logger?: FastifyBaseLogger;
  channelWebhook?: {
    handleWebhook(instanceId: string, request: ChannelWebhookRequest): Promise<ChannelWebhookResponse>;
    stop?(): Promise<void>;
  };
};

export type JojoHttpServer = {
  readonly app: FastifyInstance;
  readonly core: JojoServerCore;
  listen(): Promise<string>;
  close(): Promise<void>;
};

export async function createJojoHttpServer(
  core: JojoServerCore,
  options: JojoHttpServerOptions = {}
): Promise<JojoHttpServer> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 7788;
  validateBinding(host, options.allowRemote ?? false, options.token);
  const app = Fastify({
    bodyLimit: options.bodyLimit ?? 1024 * 1024,
    requestIdHeader: 'x-request-id',
    ...(options.logger ? { loggerInstance: options.logger } : { logger: false }),
    logController: new LogController({ disableRequestLogging: true })
  });
  if (options.logger) {
    app.addHook('onResponse', async (request, reply) => {
      request.log.info({
        event: 'http.request.completed',
        requestId: request.id,
        method: request.method,
        route: request.routeOptions.url,
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime * 100) / 100
      });
    });
    app.addHook('onError', async (request, reply, error) => {
      request.log.error({
        event: 'http.request.failed',
        requestId: request.id,
        method: request.method,
        route: request.routeOptions.url,
        statusCode: reply.statusCode,
        error
      });
    });
  }
  const rawJsonBodies = new WeakMap<object, Uint8Array>();
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    const bytes = typeof body === 'string' ? Buffer.from(body) : body;
    rawJsonBodies.set(request, new Uint8Array(bytes));
    try { done(null, JSON.parse(bytes.toString('utf8')) as unknown); }
    catch (error) { done(error as Error); }
  });
  await app.register(websocket, { options: { maxPayload: options.maxWebSocketPayloadBytes ?? 1024 * 1024 } });

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_request, reply) => {
    if (app.server.listening) return { status: 'ready' };
    return reply.code(503).send({ status: 'not_ready' });
  });

  if (options.channelWebhook) {
    app.post('/api/v1/channels/webhook/:instanceId', async (request, reply) => {
      const response = await options.channelWebhook!.handleWebhook(param(request, 'instanceId'), {
        method: request.method,
        headers: normalizedHeaders(request.headers),
        ...(rawJsonBodies.get(request) ? { rawBody: rawJsonBodies.get(request)! } : {}),
        body: request.body
      });
      for (const [name, value] of Object.entries(response.headers ?? {})) reply.header(name, value);
      return reply.code(response.status).send(response.body);
    });
  }

  app.get('/api/v1/server', async (request, reply) => withHttp(request, reply, options.token, async () => core.info));
  app.get('/api/v1/capabilities', async (request, reply) => withHttp(request, reply, options.token, async () => core.capabilities));
  app.get('/api/v1/models', async (request, reply) => withHttp(request, reply, options.token, async () => core.models));
  app.get('/api/v1/channels', async (request, reply) => withHttp(request, reply, options.token, (ctx) => (
    core.listChannelInstances(ctx)
  )));
  app.get('/api/v1/channels/:instanceId', async (request, reply) => withHttp(request, reply, options.token, (ctx) => (
    core.getChannelInstance(ctx, param(request, 'instanceId'))
  )));
  app.post('/api/v1/channels', async (request, reply) => withHttp(request, reply, options.token, async (ctx) => {
    const result = await core.createChannelInstance(
      ctx, parse(CreateChannelInstanceInputSchema, request.body), header(request, 'idempotency-key')
    );
    return reply.code(201).send(result);
  }));
  app.patch('/api/v1/channels/:instanceId', async (request, reply) => withHttp(request, reply, options.token, (ctx) => (
    core.updateChannelInstance(
      ctx,
      param(request, 'instanceId'),
      parse(UpdateChannelInstanceInputSchema, request.body),
      header(request, 'idempotency-key')
    )
  )));
  app.delete('/api/v1/channels/:instanceId', async (request, reply) => withHttp(request, reply, options.token, async (ctx) => {
    const query = parse(ExpectedRevisionQuerySchema, request.query);
    await core.deleteChannelInstance(
      ctx, param(request, 'instanceId'), query.expectedRevision, header(request, 'idempotency-key')
    );
    return reply.code(204).send();
  }));
  app.post('/api/v1/channels/:instanceId/test', async (request, reply) => withHttp(request, reply, options.token, async (ctx) => {
    const result = await core.testChannel(
      ctx, param(request, 'instanceId'), parse(TestChannelInputSchema, request.body), header(request, 'idempotency-key')
    );
    return reply.code(202).send(result);
  }));
  app.get('/api/v1/channel-bindings', async (request, reply) => withHttp(request, reply, options.token, (ctx) => (
    core.listChannelBindings(ctx)
  )));
  app.post('/api/v1/channel-bindings', async (request, reply) => withHttp(request, reply, options.token, async (ctx) => {
    const result = await core.createChannelBinding(
      ctx, parse(CreateChannelBindingInputSchema, request.body), header(request, 'idempotency-key')
    );
    return reply.code(201).send(result);
  }));
  app.patch('/api/v1/channel-bindings/:bindingId', async (request, reply) => withHttp(request, reply, options.token, (ctx) => (
    core.updateChannelBinding(
      ctx,
      param(request, 'bindingId'),
      parse(UpdateChannelBindingInputSchema, request.body),
      header(request, 'idempotency-key')
    )
  )));
  app.delete('/api/v1/channel-bindings/:bindingId', async (request, reply) => withHttp(request, reply, options.token, async (ctx) => {
    const query = parse(ExpectedRevisionQuerySchema, request.query);
    await core.deleteChannelBinding(
      ctx, param(request, 'bindingId'), query.expectedRevision, header(request, 'idempotency-key')
    );
    return reply.code(204).send();
  }));
  app.get('/api/v1/channel-pairings', async (request, reply) => withHttp(request, reply, options.token, (ctx) => {
    const query = parse(ChannelPairingListQuerySchema, request.query);
    return core.listChannelPairings(ctx, query.status);
  }));
  app.post('/api/v1/channel-pairings/:pairingId/approve', async (request, reply) => withHttp(request, reply, options.token, (ctx) => (
    core.approveChannelPairing(
      ctx,
      param(request, 'pairingId'),
      parse(ApproveChannelPairingInputSchema, request.body),
      header(request, 'idempotency-key')
    )
  )));
  app.post('/api/v1/channel-pairings/:pairingId/reject', async (request, reply) => withHttp(request, reply, options.token, async (ctx) => {
    await core.rejectChannelPairing(ctx, param(request, 'pairingId'), header(request, 'idempotency-key'));
    return reply.code(204).send();
  }));
  app.get('/api/v1/channel-deliveries', async (request, reply) => withHttp(request, reply, options.token, (ctx) => (
    core.listChannelDeliveries(ctx, parse(ChannelDeliveryListQuerySchema, request.query))
  )));
  app.get('/api/v1/channel-deliveries/:deliveryId', async (request, reply) => withHttp(request, reply, options.token, (ctx) => (
    core.getChannelDelivery(ctx, param(request, 'deliveryId'))
  )));
  app.get('/api/v1/channel-health', async (request, reply) => withHttp(request, reply, options.token, (ctx) => (
    core.listChannelHealth(ctx)
  )));
  app.get('/api/v1/sessions', async (request, reply) => withHttp(request, reply, options.token, (ctx) => core.listSessions(ctx)));
  app.post('/api/v1/sessions', async (request, reply) => withHttp(request, reply, options.token, async (ctx) => {
    const input = parse(CreateSessionInputSchema, request.body);
    const result = await core.createSession(ctx, input, header(request, 'idempotency-key'));
    return reply.code(201).send(result);
  }));
  app.get('/api/v1/sessions/:sessionId', async (request, reply) => withHttp(request, reply, options.token, (ctx) => (
    core.getSession(ctx, param(request, 'sessionId'))
  )));
  app.patch('/api/v1/sessions/:sessionId', async (request, reply) => withHttp(request, reply, options.token, (ctx) => (
    core.patchSession(
      ctx,
      param(request, 'sessionId'),
      parse(PatchSessionMetadataInputSchema, request.body),
      header(request, 'idempotency-key')
    )
  )));
  app.get('/api/v1/sessions/:sessionId/transcript', async (request, reply) => withHttp(request, reply, options.token, (ctx) => (
    core.transcript(ctx, param(request, 'sessionId'), parse(TranscriptQuerySchema, request.query))
  )));
  app.post('/api/v1/sessions/:sessionId/runs', async (request, reply) => withHttp(request, reply, options.token, async (ctx) => {
    const result = await core.startRun(
      ctx,
      param(request, 'sessionId'),
      parse(StartRunInputSchema, request.body),
      header(request, 'idempotency-key')
    );
    return reply.code(202).send(result);
  }));
  app.get('/api/v1/sessions/:sessionId/runs/:runId', async (request, reply) => withHttp(request, reply, options.token, (ctx) => (
    core.getRun(ctx, param(request, 'sessionId'), param(request, 'runId'))
  )));
  app.post('/api/v1/sessions/:sessionId/runs/:runId/cancel', async (request, reply) => withHttp(request, reply, options.token, async (ctx) => {
    const body = request.body as { reason?: unknown } | undefined;
    const reason = typeof body?.reason === 'string' ? body.reason : undefined;
    await core.cancelRun(ctx, param(request, 'sessionId'), param(request, 'runId'), reason);
    return reply.code(204).send();
  }));
  app.get('/api/v1/sessions/:sessionId/approvals', async (request, reply) => withHttp(request, reply, options.token, async (ctx) => {
    const snapshot = await core.getSession(ctx, param(request, 'sessionId'));
    return snapshot.pendingApprovals;
  }));
  app.post('/api/v1/approvals/:approvalId/resolve', async (request, reply) => withHttp(request, reply, options.token, async (ctx) => {
    const input = parse(ResolveApprovalInputSchema, request.body);
    await core.resolveApproval(ctx, param(request, 'approvalId'), input.decision, header(request, 'idempotency-key'));
    return reply.code(204).send();
  }));
  app.get('/api/v1/schedules', async (request, reply) => withHttp(request, reply, options.token, (ctx) => (
    core.listSchedules(ctx)
  )));
  app.post('/api/v1/schedules', async (request, reply) => withHttp(request, reply, options.token, async (ctx) => {
    const result = await core.createSchedule(
      ctx,
      parse(CreateScheduleInputSchema, request.body),
      header(request, 'idempotency-key')
    );
    return reply.code(201).send(result);
  }));
  app.get('/api/v1/schedules/:scheduleId', async (request, reply) => withHttp(request, reply, options.token, (ctx) => (
    core.getSchedule(ctx, param(request, 'scheduleId'))
  )));
  app.patch('/api/v1/schedules/:scheduleId', async (request, reply) => withHttp(request, reply, options.token, (ctx) => (
    core.updateSchedule(
      ctx,
      param(request, 'scheduleId'),
      parse(UpdateScheduleInputSchema, request.body),
      header(request, 'idempotency-key')
    )
  )));
  app.delete('/api/v1/schedules/:scheduleId', async (request, reply) => withHttp(request, reply, options.token, async (ctx) => {
    await core.deleteSchedule(ctx, param(request, 'scheduleId'), header(request, 'idempotency-key'));
    return reply.code(204).send();
  }));
  app.post('/api/v1/schedules/:scheduleId/run', async (request, reply) => withHttp(request, reply, options.token, async (ctx) => {
    const result = await core.runScheduleNow(
      ctx,
      param(request, 'scheduleId'),
      parse(RunScheduleNowInputSchema, request.body ?? {}),
      header(request, 'idempotency-key')
    );
    return reply.code(202).send(result);
  }));
  app.get('/api/v1/schedules/:scheduleId/runs', async (request, reply) => withHttp(request, reply, options.token, (ctx) => (
    core.listScheduleRuns(
      ctx,
      param(request, 'scheduleId'),
      parse(ScheduleRunListQuerySchema, request.query)
    )
  )));
  app.get('/api/v1/schedule-runs/:runId', async (request, reply) => withHttp(request, reply, options.token, (ctx) => (
    core.getScheduleRun(ctx, param(request, 'runId'))
  )));
  app.post('/api/v1/schedule-runs/:runId/cancel', async (request, reply) => withHttp(request, reply, options.token, async (ctx) => {
    await core.cancelScheduleRun(ctx, param(request, 'runId'), header(request, 'idempotency-key'));
    return reply.code(204).send();
  }));

  app.get('/api/v1/events', { websocket: true }, (socket, _request) => {
    const connectionId = `conn_${crypto.randomUUID()}`;
    let principal: Principal | undefined;
    let clientId: string | undefined;
    let connectionSeq = 0;
    const attached = new Set<string>();
    let unsubscribe: (() => void) | undefined;
    const send = (message: ServerWireMessage) => {
      if (socket.readyState !== socket.OPEN) return;
      if (socket.bufferedAmount > (options.maxPendingBytes ?? 4 * 1024 * 1024)) {
        socket.close(1013, 'slow_consumer');
        return;
      }
      socket.send(JSON.stringify(message));
    };
    const fail = (error: unknown, id?: string) => {
      const protocol = asProtocolError(error);
      if (id) send({ type: 'response', id, ok: false, error: protocol });
      else send({ type: 'hello_error', error: protocol });
    };
    socket.on('message', (raw: unknown) => {
      void (async () => {
        let value: unknown;
        try { value = JSON.parse(Buffer.isBuffer(raw) ? raw.toString() : String(raw)); }
        catch { throw new ProtocolFailure({ code: 'invalid_request', message: 'WebSocket message must be valid JSON.' }); }
        if (!principal) {
          const hello = parse(ClientHelloSchema, value);
          if (hello.version !== JOJO_SERVER_PROTOCOL_VERSION) {
            throw new ProtocolFailure({
              code: 'protocol_version_unsupported',
              message: 'Protocol version is not supported.'
            });
          }
          principal = authenticateToken(options.token, hello.auth?.token);
          clientId = hello.client.id;
          unsubscribe = core.subscribe((event) => {
            if (event.type === 'schedule.changed' || event.type === 'schedule.deleted'
              || event.type === 'schedule.run.changed') {
              if (principal!.scopes.includes('admin') || principal!.scopes.includes('schedules:read')) {
                send({ type: 'schedule.event', event });
              }
              return;
            }
            if (event.type === 'runtime.event') {
              if (!attached.has(event.envelope.sessionId)) return;
              connectionSeq += 1;
              send({
                type: 'event',
                seq: connectionSeq,
                sessionSeq: event.envelope.sequence,
                sessionId: event.envelope.sessionId,
                event: event.envelope
              });
              return;
            }
            const sessionId = event.type === 'run.updated'
              ? event.run.sessionId
              : event.type === 'session.metadata.updated'
                ? event.sessionId
                : event.approval.sessionId;
            if (!attached.has(sessionId)) return;
            const snapshotContext: RequestContext = {
              requestId: `event_${crypto.randomUUID()}`,
              principal: principal!,
              connectionId,
              clientId: clientId!
            };
            void core.getSession(snapshotContext, sessionId)
              .then((snapshot) => send({ type: 'session.snapshot', snapshot }))
              .catch(() => undefined);
          });
          send({ type: 'hello', version: JOJO_SERVER_PROTOCOL_VERSION, connectionId, server: core.info });
          return;
        }
        const command = parse(ClientCommandSchema, value);
        const ctx: RequestContext = {
          requestId: command.id,
          principal,
          connectionId,
          clientId: clientId!
        };
        try {
          const result = await core.dispatch(ctx, command);
          if (command.type === 'session.attach') attached.add(command.input.sessionId);
          if (command.type === 'session.detach') attached.delete(command.sessionId);
          send({ type: 'response', id: command.id, ok: true, result: result ?? null });
        } catch (error) {
          fail(error, command.id);
        }
      })().catch((error) => {
        fail(error);
        socket.close(1008, 'protocol_error');
      });
    });
    socket.on('close', () => {
      unsubscribe?.();
      core.closeConnection(connectionId);
    });
  });

  return {
    app,
    core,
    listen: () => app.listen({ host, port }),
    async close() {
      await app.close();
      await options.channelWebhook?.stop?.();
      await core.close();
    }
  };
}

async function withHttp<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  token: string | undefined,
  work: (ctx: RequestContext) => Promise<T> | T
): Promise<T | FastifyReply> {
  try {
    const principal = authenticateHeader(token, request.headers.authorization);
    const connectionId = header(request, 'x-jojo-connection-id');
    const ctx: RequestContext = {
      requestId: request.id,
      principal,
      ...(connectionId ? { connectionId } : {})
    };
    return await work(ctx);
  } catch (error) {
    const protocol = asProtocolError(error, request.id);
    return reply.code(protocolStatus(protocol.code)).send({ error: protocol });
  }
}

function authenticateHeader(expected: string | undefined, authorization: string | undefined): Principal {
  if (!expected) return { id: 'local', type: 'local', scopes: ['admin'] };
  const match = /^Bearer\s+(.+)$/iu.exec(authorization ?? '');
  return authenticateToken(expected, match?.[1]);
}

function authenticateToken(expected: string | undefined, actual: string | undefined): Principal {
  if (!expected) return { id: 'local', type: 'local', scopes: ['admin'] };
  if (!actual || !secureEqual(expected, actual)) {
    throw new ProtocolFailure({ code: 'unauthorized', message: 'Authentication failed.' });
  }
  return { id: 'admin-token', type: 'token', scopes: ['admin'] };
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parse<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ProtocolFailure({
    code: 'invalid_request',
    message: 'Request validation failed.',
    details: result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
  });
}

const ExpectedRevisionQuerySchema = z.object({
  expectedRevision: z.coerce.number().int().positive().optional()
}).strict();

function param(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, unknown>)[name];
  if (typeof value !== 'string' || !value) throw new ProtocolFailure({ code: 'invalid_request', message: `Missing ${name}.` });
  return value;
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function normalizedHeaders(headers: FastifyRequest['headers']): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [
    name.toLowerCase(), Array.isArray(value) ? value[0] : value
  ]));
}

function validateBinding(host: string, allowRemote: boolean, token: string | undefined): void {
  const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
  if (!loopback && !allowRemote) throw new Error('remote_binding_requires_allow_remote');
  if (!loopback && !token) throw new Error('remote_binding_requires_token');
}
