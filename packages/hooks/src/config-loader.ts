import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  AgentEvent,
  HookConfigStatus,
  HookEventName,
  HookFileConfig,
  HookInvocationStore,
  HookLogger,
  HookPayloadMap,
  HookSettingsSnapshot,
  HookSource
} from '@desktop-agent/contracts';
import { parseHookConfig, parseHookDuration } from './config.js';
import { DefaultHookRuntime } from './engine.js';
import { HookExecutionError } from './errors.js';
import { MemoryHookInvocationStore } from './invocation-store.js';
import { parseInjectionOutput, parsePreToolOutput } from './output-parser.js';
import { HookRegistry } from './registry.js';
import { ShellHookRunner } from './shell-runner.js';
import { FileHookTrustStore, hookConfigFingerprint, type HookTrustStore } from './trust.js';

export type { HookConfigStatus };

export type LoadHookRuntimeOptions = {
  workingDirectory: string;
  includeProject?: boolean;
  userConfigPath?: string;
  trustStore?: HookTrustStore;
  invocationStore?: HookInvocationStore;
  logger?: HookLogger;
  emit?: (event: AgentEvent) => void;
  signal?: AbortSignal;
  shellRunner?: ShellHookRunner;
};

async function readOptional(filename: string): Promise<string | undefined> {
  try { return await readFile(filename, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function registerShellConfig(
  registry: HookRegistry,
  config: HookFileConfig,
  source: HookSource,
  cwd: string,
  shell: ShellHookRunner
): void {
  for (const [event, specs] of Object.entries(config.hooks) as [HookEventName, NonNullable<HookFileConfig['hooks'][HookEventName]>][]) {
    for (const spec of specs) {
      registry.on(event, async (payload, context) => {
        const result = await shell.run({
          command: spec.command,
          payload: payload as HookPayloadMap[HookEventName],
          cwd,
          timeoutMs: parseHookDuration(spec.timeout),
          ...(spec.env ? { env: spec.env } : {}),
          signal: context.signal
        });
        if (event === 'PreToolUse') return parsePreToolOutput(result) as never;
        if (event === 'SessionStart' || event === 'UserPromptSubmit' || event === 'PostToolUse') {
          return parseInjectionOutput(result) as never;
        }
        if (result.exitCode !== 0) {
          throw new HookExecutionError('hook_exit_nonzero', `Hook exited with code ${result.exitCode}.`);
        }
        return undefined as never;
      }, {
        id: `${source}.${spec.id}`,
        source,
        ...(spec.matcher ? { matcher: spec.matcher } : {}),
        async: spec.async,
        canApprove: spec.canApprove,
        onError: spec.onError
      });
    }
  }
}

export async function loadHookRuntime(options: LoadHookRuntimeOptions): Promise<{
  runtime: DefaultHookRuntime;
  registry: HookRegistry;
  statuses: HookConfigStatus[];
}> {
  const userConfigPath = options.userConfigPath ?? path.join(os.homedir(), '.jojo', 'hooks.yml');
  const projectConfigPath = path.join(options.workingDirectory, '.jojo', 'hooks.yml');
  const trustStore = options.trustStore ?? new FileHookTrustStore(path.join(os.homedir(), '.jojo', 'hooks-trust.json'));
  const registry = new HookRegistry();
  const shell = options.shellRunner ?? new ShellHookRunner();
  const statuses: HookConfigStatus[] = [];
  const includeProject = options.includeProject !== false;

  for (const entry of [
    { source: 'user' as const, filename: userConfigPath, cwd: options.workingDirectory },
    ...(includeProject ? [{ source: 'project' as const, filename: projectConfigPath, cwd: options.workingDirectory }] : [])
  ]) {
    let content: string | undefined;
    try { content = await readOptional(entry.filename); }
    catch (error) {
      statuses.push({ source: entry.source, path: entry.filename, state: 'invalid', error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (content === undefined) {
      statuses.push({ source: entry.source, path: entry.filename, state: 'missing' });
      continue;
    }
    const fingerprint = hookConfigFingerprint(content);
    let config: HookFileConfig;
    try { config = parseHookConfig(content, entry.source); }
    catch (error) {
      statuses.push({ source: entry.source, path: entry.filename, state: 'invalid', fingerprint, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const commands = Object.entries(config.hooks).flatMap(([event, specs]) => (specs ?? []).map((spec) => ({
      event: event as HookEventName,
      id: spec.id,
      command: spec.command,
      canApprove: spec.canApprove
    })));
    if (entry.source === 'project' && await trustStore.isDisabled(entry.filename)) {
      statuses.push({ source: entry.source, path: entry.filename, state: 'disabled', fingerprint, commands });
      continue;
    }
    if (entry.source === 'project' && !await trustStore.isTrusted(entry.filename, fingerprint)) {
      statuses.push({ source: entry.source, path: entry.filename, state: 'untrusted', fingerprint, commands });
      continue;
    }
    try {
      registerShellConfig(registry, config, entry.source, entry.cwd, shell);
      statuses.push({ source: entry.source, path: entry.filename, state: 'loaded', fingerprint, commands });
    } catch (error) {
      statuses.push({ source: entry.source, path: entry.filename, state: 'invalid', fingerprint, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const runtime = new DefaultHookRuntime(registry, {
    invocationStore: options.invocationStore ?? new MemoryHookInvocationStore(),
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.emit ? { emit: options.emit } : {}),
    ...(options.signal ? { signal: options.signal } : {})
  });
  await runtime.recoverPendingSideEffects();
  return {
    registry,
    statuses,
    runtime
  };
}

export function hookSettingsSnapshot(statuses: HookConfigStatus[]): HookSettingsSnapshot {
  const user = statuses.find((status) => status.source === 'user');
  const project = statuses.find((status) => status.source === 'project');
  if (!user) throw new Error('hook_status_missing_user');
  return { user, ...(project ? { project } : {}) };
}

export async function loadHookSettings(options: LoadHookRuntimeOptions): Promise<HookSettingsSnapshot> {
  return hookSettingsSnapshot((await loadHookRuntime(options)).statuses);
}
