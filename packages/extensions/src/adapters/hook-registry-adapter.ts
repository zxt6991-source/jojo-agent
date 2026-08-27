import type {
  ContributionOwner,
  Disposable,
  HookEventName,
  HookHandler,
  RegisterExtensionHookOptions
} from '@desktop-agent/contracts';
import type { HookRegistry } from '@desktop-agent/hooks';

const LOCAL_HOOK_ID = /^[a-z][a-z0-9_.-]{0,127}$/u;

export class HookRegistryAdapter {
  constructor(private readonly registry: HookRegistry) {}

  get version(): number { return this.registry.version; }

  register<E extends HookEventName>(
    owner: ContributionOwner,
    event: E,
    handler: HookHandler<E>,
    options: RegisterExtensionHookOptions = {},
    canApproveHooks = false
  ): Disposable {
    const localId = options.id ?? `${event.toLowerCase()}-anonymous`;
    if (!LOCAL_HOOK_ID.test(localId)) throw new Error(`extension_hook_invalid_id: ${localId}`);
    if (options.canApprove && !canApproveHooks) {
      throw new Error(`extension_hook_approval_not_granted: ${owner.id}`);
    }
    return this.registry.on(event, handler, {
      id: `${owner.id}:${localId}`,
      source: owner.source === 'builtin' ? 'builtin' : 'extension',
      ...(options.matcher !== undefined ? { matcher: options.matcher } : {}),
      ...(options.async !== undefined ? { async: options.async } : {}),
      ...(options.canApprove !== undefined ? { canApprove: options.canApprove } : {}),
      ...(options.onError !== undefined ? { onError: options.onError } : {})
    });
  }
}
