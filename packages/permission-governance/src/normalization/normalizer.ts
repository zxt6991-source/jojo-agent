import { createHash } from 'node:crypto';
import path from 'node:path';
import type { RuntimeResolutionContext } from '@desktop-agent/agent-runtime';
import type { PermissionDecision, ToolCall } from '@desktop-agent/contracts';
import type {
  GovernanceContext,
  GovernanceFacts,
  GovernanceRequest,
  OperationKind,
  PermissionRequestNormalizer,
  ToolSource
} from '../types.js';

const READ_TOOLS = new Set([
  'read_file', 'list_files', 'glob', 'grep', 'web_search', 'web_fetch', 'load_skill',
  'memory_search', 'mcp_tool_manifest', 'mcp_tool_describe', 'mcp_list_resources',
  'mcp_read_resource', 'mcp_list_prompts', 'mcp_get_prompt', 'workflow_list',
  'sub_agent_status', 'sub_agent_wait', 'workflow_status', 'workflow_wait',
  'team_list', 'team_status', 'team_wait', 'team_inbox',
  'schedule_list', 'schedule_get', 'schedule_runs', 'channel_list_targets'
]);
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'save_memory']);
const CONTROL_TOOLS = new Set([
  'sub_agent_start', 'sub_agent_cancel', 'sub_agent_send', 'sub_agent_close',
  'team_delegate', 'team_send',
  'workflow_start', 'workflow_cancel', 'workflow_resume',
  'schedule_create', 'schedule_update', 'schedule_set_enabled', 'schedule_delete',
  'schedule_run_now', 'schedule_cancel_run'
]);
const BROWSER_READ_TOOLS = new Set([
  'browser_pages', 'browser_recordings', 'browser_record_get', 'browser_read', 'browser_wait',
  'browser_scroll', 'browser_screenshot', 'browser_downloads', 'browser_console',
  'browser_network', 'browser_errors'
]);

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, stableValue(child)]));
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function objectInput(call: ToolCall): Record<string, unknown> {
  return call.input && typeof call.input === 'object' && !Array.isArray(call.input)
    ? call.input as Record<string, unknown>
    : {};
}

function sourceFor(call: ToolCall, baseline: PermissionDecision): ToolSource {
  if (call.name.startsWith('channel_')) return 'channel';
  if (call.name.startsWith('mcp__') || call.name.startsWith('mcp_') || (baseline.decision === 'ask' && baseline.request.security?.kind === 'mcp')) return 'mcp';
  if (call.name.startsWith('browser_')) return 'browser';
  if (call.name.includes('memory')) return 'memory';
  if (call.name.startsWith('sub_agent_') || call.name.startsWith('workflow_')
    || call.name.startsWith('team_') || call.name.startsWith('schedule_')) return 'orchestration';
  if (call.name === 'load_skill' || call.name === 'install_skill') return 'skill';
  if (call.name.includes('hook')) return 'hook';
  return 'native';
}

function operationsFor(call: ToolCall, source: ToolSource, mcpRisk?: 'read' | 'external_side_effect'): OperationKind[] {
  if (call.name === 'channel_send') return ['network', 'external_effect'];
  if (call.name === 'terminal') return ['execute'];
  if (call.name === 'install_skill') return ['install', 'write'];
  if (call.name === 'trust_project_hooks') return ['trust', 'control'];
  if (source === 'mcp') return mcpRisk === 'read' ? ['read', 'network'] : ['network', 'external_effect'];
  if (source === 'browser') return BROWSER_READ_TOOLS.has(call.name) ? ['read', 'network'] : ['network', 'external_effect'];
  if (WRITE_TOOLS.has(call.name)) return ['write'];
  if (CONTROL_TOOLS.has(call.name)) return ['control'];
  if (call.name === 'web_search' || call.name === 'web_fetch') return ['read', 'network'];
  if (READ_TOOLS.has(call.name)) return ['read'];
  return ['control'];
}

function contextFor(context: RuntimeResolutionContext): GovernanceContext {
  const actor = context.actor ?? { kind: 'main' as const };
  const trigger = context.trigger?.kind ?? (actor.kind === 'workflow' || context.workflow
    ? 'workflow' as const
    : actor.kind === 'subagent'
      ? 'subagent' as const
      : actor.kind === 'team_member'
        ? 'team_member' as const
      : 'user' as const);
  return {
    sessionId: context.sessionId,
    laneId: context.laneId,
    runId: context.runId,
    actor,
    trigger: { kind: trigger },
    ...(context.team ? { team: context.team } : {}),
    workingDirectory: context.workingDirectory,
    executionScope: context.executionScope,
    interactive: actor.kind === 'main' && trigger === 'user'
  };
}

function resourceScopeFor(call: ToolCall, source: ToolSource, baseline: PermissionDecision): GovernanceFacts['resourceScope'] {
  if (source === 'browser' || source === 'mcp' || source === 'channel' || call.name === 'web_search' || call.name === 'web_fetch') return 'external';
  if (baseline.decision === 'ask' && call.name === 'read_file' && !baseline.request.preview) return 'outside_workspace';
  if (['read_file', 'list_files', 'glob', 'grep', 'write_file', 'edit_file', 'delete_file', 'terminal'].includes(call.name)) return 'workspace';
  return 'none';
}

function originFor(input: Record<string, unknown>): string | undefined {
  if (typeof input.url !== 'string') return undefined;
  try { return new URL(input.url).origin; } catch { return undefined; }
}

function operationIdentity(call: ToolCall, input: Record<string, unknown>, facts: GovernanceFacts): unknown {
  if (facts.terminal) return {
    cwd: typeof input.cwd === 'string' ? input.cwd : '.',
    executable: facts.terminal.executable,
    subcommand: facts.terminal.subcommand
  };
  if (facts.mcp) return facts.mcp;
  if (facts.browser) return {
    origin: facts.browser.origin,
    recordingId: typeof input.recordingId === 'string' ? input.recordingId : undefined
  };
  if (typeof input.path === 'string') return { path: input.path };
  return { tool: call.name };
}

export class DefaultPermissionRequestNormalizer implements PermissionRequestNormalizer {
  normalize(input: { call: ToolCall; context: RuntimeResolutionContext; baseline: PermissionDecision }): GovernanceRequest {
    const { call, baseline } = input;
    const governanceContext = contextFor(input.context);
    const callInput = objectInput(call);
    const security = baseline.decision === 'ask' ? baseline.request.security : undefined;
    const source = sourceFor(call, baseline);
    const mcpRisk = security?.kind === 'mcp' ? security.risk : undefined;
    const operations = operationsFor(call, source, mcpRisk);
    const terminal = security?.kind === 'terminal' ? {
      executable: path.basename(security.command).toLowerCase(),
      ...(security.argumentsPreview[0] ? { subcommand: security.argumentsPreview[0] } : {}),
      network: security.network,
      secretEnv: [...security.secretEnv].sort(),
      sandbox: security.sandbox
    } : undefined;
    const mcp = security?.kind === 'mcp' ? {
      serverId: security.serverId,
      ...(baseline.decision === 'ask' && baseline.request.grant?.key
        ? { serverFingerprint: hash(baseline.request.grant.key) }
        : {}),
      toolName: security.toolName,
      risk: security.risk
    } : undefined;
    const browserOrigin = originFor(callInput);
    const browser = source === 'browser' ? {
      ...(browserOrigin ? { origin: browserOrigin } : {}),
      externalEffect: operations.includes('external_effect')
    } : undefined;
    const risk = security?.kind === 'terminal'
      ? security.risk
      : security?.kind === 'mcp'
        ? security.risk === 'read' ? 'low' as const : 'high' as const
        : baseline.decision === 'deny'
          ? 'critical' as const
          : operations.includes('external_effect') || operations.includes('install') || operations.includes('trust')
            ? 'high' as const
            : baseline.decision === 'ask' ? 'medium' as const : 'low' as const;
    const facts: GovernanceFacts = {
      source,
      operations,
      risk,
      capabilities: security?.capabilities ? [...security.capabilities].sort() : [],
      resourceScope: resourceScopeFor(call, source, baseline),
      ...(terminal ? { terminal } : {}),
      ...(mcp ? { mcp } : {}),
      ...(browser ? { browser } : {})
    };
    const fingerprintPayload = {
      tool: call.name,
      operation: operationIdentity(call, callInput, facts),
      actor: governanceContext.actor,
      trigger: governanceContext.trigger,
      team: governanceContext.team,
      resourceScope: facts.resourceScope,
      terminal,
      mcp,
      browser
    };
    const fingerprint = hash(fingerprintPayload);
    const grantClass = hash({
      tool: call.name,
      actor: governanceContext.actor,
      trigger: governanceContext.trigger,
      team: governanceContext.team,
      source,
      operations,
      risk,
      resourceScope: facts.resourceScope,
      terminal,
      mcp,
      browser
    });
    return {
      id: crypto.randomUUID(),
      call,
      context: governanceContext,
      baseline,
      facts,
      fingerprint,
      grantClass
    };
  }
}
