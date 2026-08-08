import path from 'node:path';
import { runAgentTurn } from '@desktop-agent/agent-core';
import type { ApprovalRequest, ProviderSettings, WorkerCommand, WorkerMessage } from '@desktop-agent/contracts';
import { OpenAICompatibleProvider } from '@desktop-agent/providers';
import { JsonlSessionStore } from '@desktop-agent/storage';
import { createDefaultTools, DefaultPermissionGate } from '@desktop-agent/tools-node';

type ParentPort = { on(event: 'message', listener: (event: { data: WorkerCommand }) => void): void; postMessage(message: WorkerMessage): void };
const parentPort = (process as typeof process & { parentPort?: ParentPort }).parentPort;
if (!parentPort) throw new Error('Agent worker must run as an Electron utility process.');

const dataDirectory = process.env.DESKTOP_AGENT_DATA_DIR;
if (!dataDirectory) throw new Error('DESKTOP_AGENT_DATA_DIR is required.');
const store = new JsonlSessionStore(path.join(dataDirectory, 'sessions'));
const controllers = new Map<string, AbortController>();
const approvals = new Map<string, { resolve: (allowed: boolean) => void; sessionId: string }>();
let runtime: { settings: ProviderSettings; apiKey: string } | null = null;

const post = (message: WorkerMessage) => parentPort.postMessage(message);

function waitForApproval(request: ApprovalRequest, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (allowed: boolean) => {
      signal.removeEventListener('abort', onAbort);
      approvals.delete(request.requestId);
      resolve(allowed);
    };
    const onAbort = () => finish(false);
    signal.addEventListener('abort', onAbort, { once: true });
    approvals.set(request.requestId, { resolve: finish, sessionId: request.sessionId });
  });
}

async function startTurn(sessionId: string, text: string): Promise<void> {
  let release: (() => void) | null = null;
  let controller: AbortController | null = null;
  let failureEmitted = false;
  try {
    release = store.acquire(sessionId);
    if (!runtime?.apiKey) throw new Error('请先在设置中配置模型 API Key。');
    const session = await store.get(sessionId);
    if (!session) throw new Error('Session not found.');
    const history = await store.messages(sessionId);
    controller = new AbortController();
    controllers.set(sessionId, controller);
    await runAgentTurn({
      sessionId, workingDirectory: session.workingDirectory, model: runtime.settings.model,
      history, userText: text,
      provider: new OpenAICompatibleProvider({ apiKey: runtime.apiKey, baseUrl: runtime.settings.baseUrl }),
      tools: createDefaultTools(), permissionGate: new DefaultPermissionGate(), signal: controller.signal,
      emit: (event) => {
        if (event.type === 'turn.failed') failureEmitted = true;
        post({ type: 'agent.event', event });
      },
      approve: waitForApproval,
      commitMessage: (message) => store.appendMessage(sessionId, message)
    });
  } catch (error) {
    if (!failureEmitted) {
      post({ type: 'agent.event', event: {
        type: 'turn.failed', code: 'runtime_error', message: error instanceof Error ? error.message : String(error)
      } });
    }
  } finally {
    if (controller && controllers.get(sessionId) === controller) controllers.delete(sessionId);
    release?.();
    post({ type: 'sessions.changed' });
  }
}

parentPort.on('message', (event) => {
  const command = event.data;
  if (command.type === 'config.update') runtime = { settings: command.settings, apiKey: command.apiKey };
  else if (command.type === 'turn.start') void startTurn(command.payload.sessionId, command.payload.text);
  else if (command.type === 'turn.cancel') {
    controllers.get(command.sessionId)?.abort();
    for (const approval of approvals.values()) if (approval.sessionId === command.sessionId) approval.resolve(false);
  } else if (command.type === 'approval.resolve') {
    approvals.get(command.requestId)?.resolve(command.allow);
  }
});

post({ type: 'ready' });
