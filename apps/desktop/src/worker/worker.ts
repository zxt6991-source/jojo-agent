import path from 'node:path';
import { runAgentTurn } from '@desktop-agent/agent-core';
import {
  isPlaceholderSessionTitle, sessionTitleFromPrompt,
  type ApprovalRequest, type Message, type ModelSelection, type ProviderSettings, type WorkerCommand, type WorkerMessage
} from '@desktop-agent/contracts';
import { createProvider } from '@desktop-agent/providers';
import { JsonlSessionStore } from '@desktop-agent/storage';
import { createDefaultToolRuntime, redactSensitiveEnvironmentAssignments } from '@desktop-agent/tools-node';

type ParentPort = { on(event: 'message', listener: (event: { data: WorkerCommand }) => void): void; postMessage(message: WorkerMessage): void };
const parentPort = (process as typeof process & { parentPort?: ParentPort }).parentPort;
if (!parentPort) throw new Error('Agent worker must run as an Electron utility process.');

const configuredDataDirectory = process.env.DESKTOP_AGENT_DATA_DIR;
if (!configuredDataDirectory) throw new Error('DESKTOP_AGENT_DATA_DIR is required.');
const dataDirectory: string = configuredDataDirectory;
const store = new JsonlSessionStore(path.join(dataDirectory, 'sessions'));
const controllers = new Map<string, AbortController>();
const approvals = new Map<string, { resolve: (allowed: boolean) => void; sessionId: string }>();
let runtime: { settings: ProviderSettings; apiKeys: Record<string, string> } | null = null;

function redactLegacyTerminalOutput(messages: Message[]): Message[] {
  return messages.map((message) => ({
    ...message,
    content: message.content.map((block) => block.type === 'tool_result'
      ? {
          ...block,
          result: {
            ...block.result,
            content: redactSensitiveEnvironmentAssignments(block.result.content)
          }
        }
      : block)
  }));
}

const post = (message: WorkerMessage) => parentPort.postMessage(message);

async function utilityCompletion(
  selection: ModelSelection,
  prompt: string,
  signal: AbortSignal,
  maxOutputTokens: number
): Promise<string> {
  if (!runtime) throw new Error('Provider settings are unavailable.');
  const config = runtime.settings.providers.find((provider) => provider.id === selection.providerId);
  const apiKey = runtime.apiKeys[selection.providerId];
  if (!config || !apiKey) throw new Error('Utility model is not configured.');
  const message: Message = {
    id: crypto.randomUUID(), role: 'user', createdAt: new Date().toISOString(),
    content: [{ type: 'text', text: prompt }]
  };
  let text = '';
  for await (const event of createProvider(config, apiKey).stream({
    model: selection.model, messages: [message], tools: [], signal, maxOutputTokens
  })) {
    if (event.type === 'text_delta') text += event.text;
    else if (event.type === 'response_failed') throw new Error(event.message);
  }
  if (!text.trim()) throw new Error('Utility model returned no text.');
  return text.trim();
}

async function maybeGenerateTitle(
  sessionId: string,
  workingDirectory: string,
  currentTitle: string,
  history: Message[],
  prompt: string,
  signal: AbortSignal
): Promise<void> {
  if (history.some((message) => message.role === 'user') || !isPlaceholderSessionTitle(currentTitle, workingDirectory)) return;
  let title: string;
  try {
    title = sessionTitleFromPrompt(await utilityCompletion(
      runtime!.settings.utilityModel,
      `Create a concise plain-text title (at most 60 characters) for this coding task. Output only the title.\n\n${prompt}`,
      signal,
      96
    ));
  } catch {
    title = sessionTitleFromPrompt(prompt);
  }
  if (title) {
    await store.rename(sessionId, title);
    post({ type: 'sessions.changed' });
  }
}

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

async function startTurn(sessionId: string, text: string, providerId: string, model: string): Promise<void> {
  let release: (() => void) | null = null;
  let controller: AbortController | null = null;
  let failureEmitted = false;
  try {
    release = store.acquire(sessionId);
    if (!runtime) throw new Error('模型配置尚未加载。');
    const providerConfig = runtime.settings.providers.find((provider) => provider.id === providerId);
    if (!providerConfig) throw new Error(`Provider“${providerId}”不存在。`);
    const apiKey = runtime.apiKeys[providerId];
    if (!apiKey) throw new Error(`请先在设置中配置 ${providerConfig.name} API Key。`);
    if (!providerConfig.models.includes(model)) throw new Error(`模型“${model}”不在 ${providerConfig.name} 的可用模型中。`);
    const session = await store.get(sessionId);
    if (!session) throw new Error('Session not found.');
    const history = redactLegacyTerminalOutput(await store.messages(sessionId));
    controller = new AbortController();
    controllers.set(sessionId, controller);
    await maybeGenerateTitle(sessionId, session.workingDirectory, session.title, history, text, controller.signal);
    const toolRuntime = createDefaultToolRuntime({ trashDirectory: path.join(dataDirectory, 'trash') });
    await runAgentTurn({
      sessionId, workingDirectory: session.workingDirectory, model,
      history, userText: text,
      provider: createProvider(providerConfig, apiKey),
      tools: toolRuntime.tools, permissionGate: toolRuntime.permissionGate, signal: controller.signal,
      contextWindowTokens: providerConfig.contextWindowTokens,
      maxOutputTokens: providerConfig.maxOutputTokens,
      summarize: (source, signal) => utilityCompletion(
        runtime!.settings.utilityModel,
        `Summarize the conversation below for another coding model. Preserve user requirements, decisions, file paths, errors, unresolved work, and tool outcomes. Never invent facts.\n\n${source}`,
        signal,
        1_024
      ),
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
  if (command.type === 'config.update') runtime = { settings: command.settings, apiKeys: command.apiKeys };
  else if (command.type === 'turn.start') void startTurn(command.payload.sessionId, command.payload.text, command.payload.providerId, command.payload.model);
  else if (command.type === 'turn.cancel') {
    controllers.get(command.sessionId)?.abort();
    for (const approval of approvals.values()) if (approval.sessionId === command.sessionId) approval.resolve(false);
  } else if (command.type === 'approval.resolve') {
    approvals.get(command.requestId)?.resolve(command.allow);
  }
});

post({ type: 'ready' });
