import type {
  HookEventName,
  HookHandler,
  HookSource
} from '@desktop-agent/contracts';
import { compileHookMatcher } from './matcher.js';

export type RegisteredHook<E extends HookEventName = HookEventName> = {
  id: string;
  event: E;
  source: HookSource;
  handler: HookHandler<E>;
  matcher?: RegExp;
  async: boolean;
  canApprove: boolean;
  onError: 'continue' | 'block';
};

export type RegisterHookOptions = {
  id?: string;
  source?: HookSource;
  matcher?: string | RegExp;
  async?: boolean;
  canApprove?: boolean;
  onError?: 'continue' | 'block';
};

export interface Disposable { dispose(): void; }

export class HookRegistry {
  private readonly hooks = new Map<HookEventName, unknown[]>();
  private sequence = 0;
  private registryVersion = 0;

  get version(): number { return this.registryVersion; }

  on<E extends HookEventName>(
    event: E,
    handler: HookHandler<E>,
    options: RegisterHookOptions = {}
  ): Disposable {
    const source = options.source ?? 'builtin';
    const id = options.id ?? `${source}.anonymous-${++this.sequence}`;
    if ([...this.hooks.values()].flat().some((hook) => (hook as { id: string }).id === id)) {
      throw new Error(`hook_duplicate_id: ${id}`);
    }
    const matcher = typeof options.matcher === 'string' ? compileHookMatcher(options.matcher) : options.matcher;
    const registered: RegisteredHook<E> = {
      id,
      event,
      source,
      handler,
      ...(matcher ? { matcher } : {}),
      async: options.async ?? false,
      canApprove: options.canApprove ?? false,
      onError: options.onError ?? 'continue'
    };
    const current = this.hooks.get(event) ?? [];
    this.hooks.set(event, [...current, registered]);
    this.registryVersion += 1;
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        const hooks = this.hooks.get(event) ?? [];
        this.hooks.set(event, hooks.filter((hook) => hook !== registered));
        this.registryVersion += 1;
      }
    };
  }

  configured(event: HookEventName): boolean {
    return (this.hooks.get(event)?.length ?? 0) > 0;
  }

  snapshot<E extends HookEventName>(event: E): RegisteredHook<E>[] {
    return [...(this.hooks.get(event) ?? [])] as RegisteredHook<E>[];
  }
}
