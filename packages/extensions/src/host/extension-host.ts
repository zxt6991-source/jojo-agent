import type {
  AgentProfileContribution,
  ContextContributor,
  ContributionOwner,
  Disposable,
  ExtensionAPI,
  ExtensionCapability,
  ExtensionIdentity,
  ExtensionManifest,
  ExtensionPermission,
  ExtensionRuntimeView,
  HookEventName,
  HookHandler,
  MemoryAdapterContribution,
  ProviderContribution,
  RegisterExtensionHookOptions,
  ToolContribution,
  WorkflowStepContribution
} from '@desktop-agent/contracts';
import { ContributionOwnerSchema, ExtensionManifestSchema } from '@desktop-agent/contracts';
import type { HookRegistry } from '@desktop-agent/hooks';
import type { AgentProfileRegistry } from '@desktop-agent/orchestration';
import type { ProviderRegistry } from '@desktop-agent/providers';
import { AgentProfileRegistryAdapter } from '../adapters/agent-profile-registry-adapter.js';
import { HookRegistryAdapter } from '../adapters/hook-registry-adapter.js';
import { PreviewContributionRegistry } from '../adapters/preview-registry.js';
import { ProviderRegistryAdapter } from '../adapters/provider-registry-adapter.js';
import { ContextContributionRegistry } from '../api/context-registry.js';
import { ToolContributionRegistry } from '../api/tool-registry.js';
import {
  MemoryExtensionStorageBackend,
  NamespacedExtensionStorage,
  type ExtensionStorageBackend
} from '../storage/extension-storage.js';
import { EMPTY_EXTENSION_RUNTIME_VIEW } from './runtime-view.js';

export type ExtensionLifecycleState =
  | 'validating'
  | 'activating'
  | 'running'
  | 'draining'
  | 'deactivating'
  | 'disposed'
  | 'failed';

export type ExtensionDefinition = {
  owner: ContributionOwner;
  name?: string;
  apiVersion?: string;
  capabilities?: readonly ExtensionCapability[];
  permissions?: readonly ExtensionPermission[];
  /** Required only for external code. Loader/fingerprint verification remains deferred. */
  manifest?: ExtensionManifest;
  activate(api: ExtensionAPI): void | Disposable | Promise<void | Disposable>;
  deactivate?(): void | Promise<void>;
};

export type ExtensionActivationGrant = {
  trusted?: boolean;
  capabilities?: readonly ExtensionCapability[];
  permissions?: readonly ExtensionPermission[];
  canApproveHooks?: boolean;
};

export type ExtensionHostOptions = {
  tools?: ToolContributionRegistry;
  contexts?: ContextContributionRegistry;
  hooks?: HookRegistry;
  providers?: ProviderRegistry;
  agentProfiles?: AgentProfileRegistry;
  workflowSteps?: PreviewContributionRegistry<WorkflowStepContribution>;
  memoryAdapters?: PreviewContributionRegistry<MemoryAdapterContribution>;
  runtime?: ExtensionRuntimeView;
  storage?: ExtensionStorageBackend;
};

export type ContributionSnapshot = {
  revision: number;
  toolCatalogVersion: number;
  hookRegistryVersion: number;
  contextRegistryVersion: number;
  providerRegistrationVersion: number;
  agentProfileRevision: number;
  extensions: Array<{ id: string; version: string }>;
};

type ActiveExtension = {
  definition: ExtensionDefinition;
  identity: ExtensionIdentity;
  state: ExtensionLifecycleState;
  capabilities: Set<ExtensionCapability>;
  permissions: Set<ExtensionPermission>;
  canApproveHooks: boolean;
  disposables: Disposable[];
};

export interface ExtensionHandle extends Disposable {
  readonly id: string;
  readonly state: ExtensionLifecycleState;
}

function unique<T>(values: readonly T[]): T[] { return [...new Set(values)]; }

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

function immutableCopy<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function restrictedRuntimeView(runtime: ExtensionRuntimeView, allowed: boolean): ExtensionRuntimeView {
  const denied = async (): Promise<never> => {
    throw new Error('extension_permission_not_granted: runtime.observe');
  };
  if (allowed) return {
    async getSessionInfo(sessionId) {
      const value = await runtime.getSessionInfo(sessionId);
      return value ? immutableCopy(value) : undefined;
    },
    async getLaneInfo(sessionId, laneId) {
      const value = await runtime.getLaneInfo(sessionId, laneId);
      return value ? immutableCopy(value) : undefined;
    },
    async getRunSnapshot(runId) {
      const value = await runtime.getRunSnapshot(runId);
      return value ? immutableCopy(value) : undefined;
    },
    subscribe(listener) {
      return runtime.subscribe((event) => listener(immutableCopy(event)));
    }
  };
  return {
    getSessionInfo: denied,
    getLaneInfo: denied,
    getRunSnapshot: denied,
    subscribe() { throw new Error('extension_permission_not_granted: runtime.observe'); }
  };
}

export class ExtensionHost {
  readonly tools: ToolContributionRegistry;
  readonly contexts: ContextContributionRegistry;
  readonly workflowSteps: PreviewContributionRegistry<WorkflowStepContribution>;
  readonly memoryAdapters: PreviewContributionRegistry<MemoryAdapterContribution>;

  private readonly hookAdapter: HookRegistryAdapter | undefined;
  private readonly providerAdapter: ProviderRegistryAdapter | undefined;
  private readonly profileAdapter: AgentProfileRegistryAdapter | undefined;
  private readonly runtime: ExtensionRuntimeView;
  private readonly storage: ExtensionStorageBackend;
  private readonly active = new Map<string, ActiveExtension>();
  private hostRevision = 0;

  constructor(options: ExtensionHostOptions = {}) {
    this.tools = options.tools ?? new ToolContributionRegistry();
    this.contexts = options.contexts ?? new ContextContributionRegistry();
    this.workflowSteps = options.workflowSteps ?? new PreviewContributionRegistry();
    this.memoryAdapters = options.memoryAdapters ?? new PreviewContributionRegistry();
    this.hookAdapter = options.hooks ? new HookRegistryAdapter(options.hooks) : undefined;
    this.providerAdapter = options.providers ? new ProviderRegistryAdapter(options.providers) : undefined;
    this.profileAdapter = options.agentProfiles ? new AgentProfileRegistryAdapter(options.agentProfiles) : undefined;
    this.runtime = options.runtime ?? EMPTY_EXTENSION_RUNTIME_VIEW;
    this.storage = options.storage ?? new MemoryExtensionStorageBackend();
  }

  async activate(definition: ExtensionDefinition, grant: ExtensionActivationGrant = {}): Promise<ExtensionHandle> {
    const owner = ContributionOwnerSchema.parse(definition.owner);
    if (this.active.has(owner.id)) throw new Error(`extension_already_active: ${owner.id}`);
    const requested = this.validateDefinition(definition, owner, grant);
    const identity: ExtensionIdentity = Object.freeze({
      ...owner,
      ...(definition.name ?? definition.manifest?.name
        ? { name: definition.name ?? definition.manifest!.name }
        : {}),
      ...(definition.apiVersion ?? definition.manifest?.apiVersion
        ? { apiVersion: definition.apiVersion ?? definition.manifest!.apiVersion }
        : {})
    });
    const active: ActiveExtension = {
      definition,
      identity,
      state: 'activating',
      capabilities: new Set(requested.capabilities),
      permissions: new Set(requested.permissions),
      canApproveHooks: grant.canApproveHooks ?? owner.source === 'builtin',
      disposables: []
    };
    this.active.set(owner.id, active);
    try {
      const activationDisposable = await definition.activate(this.apiFor(active));
      if (activationDisposable) active.disposables.push(activationDisposable);
      active.state = 'running';
      this.hostRevision += 1;
    } catch (error) {
      active.state = 'failed';
      await this.disposeContributions(active);
      this.active.delete(owner.id);
      throw error;
    }
    const currentState = () => this.active.get(owner.id)?.state ?? 'disposed';
    return {
      id: owner.id,
      get state() { return currentState(); },
      dispose: () => this.deactivate(owner.id)
    };
  }

  async deactivate(extensionId: string): Promise<void> {
    const active = this.active.get(extensionId);
    if (!active || active.state === 'disposed') return;
    active.state = 'draining';
    let failure: unknown;
    try {
      active.state = 'deactivating';
      await active.definition.deactivate?.();
    } catch (error) {
      failure = error;
    }
    await this.disposeContributions(active);
    active.state = 'disposed';
    this.active.delete(extensionId);
    this.hostRevision += 1;
    if (failure) throw failure;
  }

  state(extensionId: string): ExtensionLifecycleState | undefined {
    return this.active.get(extensionId)?.state;
  }

  snapshot(): ContributionSnapshot {
    return {
      revision: this.hostRevision,
      toolCatalogVersion: this.tools.version,
      hookRegistryVersion: this.hookAdapter?.version ?? 0,
      contextRegistryVersion: this.contexts.version,
      providerRegistrationVersion: this.providerAdapter?.version ?? 0,
      agentProfileRevision: this.profileAdapter?.version ?? 0,
      extensions: [...this.active.values()]
        .filter((extension) => extension.state === 'running')
        .map(({ identity }) => ({ id: identity.id, version: identity.version }))
        .sort((left, right) => left.id.localeCompare(right.id))
    };
  }

  private validateDefinition(
    definition: ExtensionDefinition,
    owner: ContributionOwner,
    grant: ExtensionActivationGrant
  ): { capabilities: ExtensionCapability[]; permissions: ExtensionPermission[] } {
    let declaredCapabilities = unique(definition.capabilities ?? []);
    let declaredPermissions = unique(definition.permissions ?? []);
    if (owner.source === 'external') {
      if (!grant.trusted) throw new Error(`extension_not_trusted: ${owner.id}`);
      const manifest = ExtensionManifestSchema.parse(definition.manifest);
      if (manifest.id !== owner.id || manifest.version !== owner.version) {
        throw new Error(`extension_manifest_identity_mismatch: ${owner.id}`);
      }
      declaredCapabilities = unique(manifest.capabilities);
      declaredPermissions = unique(manifest.permissions ?? []);
    }
    const capabilities = owner.source === 'builtin'
      ? declaredCapabilities
      : unique(grant.capabilities ?? []).filter((capability) => declaredCapabilities.includes(capability));
    const permissions = owner.source === 'builtin'
      ? declaredPermissions
      : unique(grant.permissions ?? []).filter((permission) => declaredPermissions.includes(permission));
    return { capabilities, permissions };
  }

  private apiFor(active: ActiveExtension): ExtensionAPI {
    const requireCapability = (capability: ExtensionCapability): void => {
      if (active.state !== 'activating' && active.state !== 'running') {
        throw new Error(`extension_not_running: ${active.identity.id}`);
      }
      if (!active.capabilities.has(capability)) {
        throw new Error(`extension_capability_not_granted: ${capability}`);
      }
    };
    const track = (disposable: Disposable): Disposable => {
      active.disposables.push(disposable);
      return disposable;
    };
    const owner: ContributionOwner = {
      id: active.identity.id,
      version: active.identity.version,
      source: active.identity.source
    };
    return Object.freeze({
      extension: active.identity,
      runtime: restrictedRuntimeView(this.runtime, active.permissions.has('runtime.observe')),
      storage: new NamespacedExtensionStorage(active.identity.id, this.storage),
      registerTool: (contribution: ToolContribution) => {
        requireCapability('tool');
        return track(this.tools.register(owner, contribution, [...active.permissions]));
      },
      registerHook: <E extends HookEventName>(
        event: E,
        handler: HookHandler<E>,
        options?: RegisterExtensionHookOptions
      ) => {
        requireCapability('hook');
        if (!this.hookAdapter) throw new Error('extension_hook_registry_unavailable');
        return track(this.hookAdapter.register(owner, event, handler, options, active.canApproveHooks));
      },
      registerContextContributor: (contribution: ContextContributor) => {
        requireCapability('context');
        return track(this.contexts.register(owner, contribution));
      },
      registerProvider: (contribution: ProviderContribution) => {
        requireCapability('provider');
        if (!this.providerAdapter) throw new Error('extension_provider_registry_unavailable');
        return track(this.providerAdapter.register(owner, contribution));
      },
      registerAgentProfile: (contribution: AgentProfileContribution) => {
        requireCapability('agent_profile');
        if (!this.profileAdapter) throw new Error('extension_agent_profile_registry_unavailable');
        return track(this.profileAdapter.register(owner, contribution));
      },
      registerWorkflowStep: (contribution: WorkflowStepContribution) => {
        requireCapability('workflow_step');
        return track(this.workflowSteps.register(owner, contribution));
      },
      registerMemoryAdapter: (contribution: MemoryAdapterContribution) => {
        requireCapability('memory');
        return track(this.memoryAdapters.register(owner, contribution));
      }
    });
  }

  private async disposeContributions(active: ActiveExtension): Promise<void> {
    const disposables = active.disposables.splice(0).reverse();
    for (const disposable of disposables) {
      try { await disposable.dispose(); } catch { /* best-effort lifecycle cleanup */ }
    }
  }
}
