import type { RuntimeActor, RuntimeTriggerContext } from '@desktop-agent/agent-runtime';
import type { JojoAppService, AppServiceEvent } from '@desktop-agent/app-service';
import type { ChannelBinding, ChannelInboundEvent, ChannelPrincipal } from '@desktop-agent/channel-core';
import type { RequestContext, RunSnapshot } from '@desktop-agent/server-protocol';

export type ChannelAgentResult = {
  sessionId: string;
  runId: string;
  status: 'completed' | 'failed' | 'cancelled' | 'interrupted';
  finalText?: string;
};

export interface ChannelAgentBridge {
  ensureSession(binding: ChannelBinding, principal: ChannelPrincipal): Promise<string>;
  run(input: {
    runId: string;
    sessionId: string;
    binding: ChannelBinding;
    event: ChannelInboundEvent;
    principal: ChannelPrincipal;
    text: string;
    onStarted?: (runId: string) => void;
  }): Promise<ChannelAgentResult>;
}

export type JojoAppChannelBridgeOptions = {
  defaultProviderId: string;
  defaultModel: string;
  idGenerator?: () => string;
};

export class JojoAppChannelBridge implements ChannelAgentBridge {
  private readonly idGenerator: () => string;

  constructor(private readonly app: JojoAppService, private readonly options: JojoAppChannelBridgeOptions) {
    this.idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
  }

  async ensureSession(binding: ChannelBinding, principal: ChannelPrincipal): Promise<string> {
    if (binding.routing.sessionMode !== 'stateless' && binding.routing.sessionId) {
      try {
        await this.app.getSession(context(principal), binding.routing.sessionId);
        return binding.routing.sessionId;
      } catch (error) {
        if (!String(error).includes('runtime_session_not_found')) throw error;
      }
    }
    const created = await this.app.createSession(context(principal), {
      id: this.idGenerator(),
      title: `Channel · ${binding.id}`,
      labels: ['channel', `channel:${binding.instanceId}`],
      executionScope: binding.routing.workspaceRoot
        ? { kind: 'workspace', workingDirectory: binding.routing.workspaceRoot }
        : { kind: 'none' }
    });
    return created.id;
  }

  async run(input: {
    runId: string;
    sessionId: string;
    binding: ChannelBinding;
    event: ChannelInboundEvent;
    principal: ChannelPrincipal;
    text: string;
    onStarted?: (runId: string) => void;
  }): Promise<ChannelAgentResult> {
    const actor: RuntimeActor = { kind: 'channel_user', id: input.principal.id };
    const trigger: RuntimeTriggerContext = { kind: 'channel_message', id: input.event.id };
    let resolveTerminal!: (run: RunSnapshot) => void;
    const terminal = new Promise<RunSnapshot>((resolve) => { resolveTerminal = resolve; });
    let runId: string | undefined;
    const unsubscribe = this.app.subscribe((event: AppServiceEvent) => {
      if (event.type === 'run.updated' && event.run.id === runId && isTerminal(event.run)) resolveTerminal(event.run);
    });
    try {
      const started = await this.app.startRun(context(input.principal), input.sessionId, {
        laneId: 'main',
        input: { content: [{ type: 'text', text: input.text }] },
        providerId: input.binding.routing.providerId ?? this.options.defaultProviderId,
        model: input.binding.routing.model ?? this.options.defaultModel,
        ...(input.binding.routing.instructions ? { instructions: input.binding.routing.instructions } : {})
      }, { runId: input.runId, actor, trigger, metadata: {
        channel: {
          bindingId: input.binding.id,
          instanceId: input.binding.instanceId,
          conversationId: input.event.conversation.id,
          ...(input.event.conversation.threadId ? { threadId: input.event.conversation.threadId } : {}),
          senderId: input.event.sender.id,
          inboundMessageId: input.event.message?.id ?? input.event.id
        }
      } });
      runId = started.id;
      input.onStarted?.(started.id);
      const latest = isTerminal(started)
        ? started
        : await this.app.getRun(context(input.principal), input.sessionId, started.id);
      const snapshot = isTerminal(latest) ? latest : await terminal;
      return {
        sessionId: input.sessionId, runId: started.id,
        status: snapshot.status as ChannelAgentResult['status'],
        ...(snapshot.result?.finalText ? { finalText: snapshot.result.finalText } : {})
      };
    } finally { unsubscribe(); }
  }
}

function context(principal: ChannelPrincipal): RequestContext {
  return {
    requestId: crypto.randomUUID(),
    principal: { id: principal.id, type: 'service', scopes: ['sessions:read', 'sessions:create', 'runs:start'] }
  };
}

function isTerminal(run: RunSnapshot): boolean {
  return ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status);
}
