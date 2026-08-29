import type { SecretBroker, SecretLease, SecretReference } from '@desktop-agent/contracts';

export type TerminalSecretRequest = {
  requestId: string;
  sessionId: string;
  name: string;
  description?: string;
};

type PendingSecret = {
  sessionId: string;
  resolve: (lease: SecretLease) => void;
  reject: (error: Error) => void;
};

function unavailable(message: string): Error {
  return Object.assign(new Error(`terminal_secret_unavailable: ${message}`), { code: 'terminal_secret_unavailable' });
}

export class InteractiveTerminalSecretBroker implements SecretBroker {
  private values = new Map<string, string>();
  private readonly pending = new Map<string, PendingSecret>();

  constructor(private readonly emit: (request: TerminalSecretRequest) => void) {}

  replace(values: Record<string, string>): void {
    this.values = new Map(Object.entries(values).filter(([, value]) => Boolean(value)));
  }

  async resolve(reference: SecretReference, context: { purpose: string; sessionId?: string }): Promise<SecretLease> {
    const value = reference.provider === 'env'
      ? process.env[reference.key] ?? this.values.get(reference.key)
      : reference.provider === 'desktop'
        ? this.values.get(reference.key)
        : undefined;
    if (value) return { value, dispose: () => undefined };
    const sessionId = context.sessionId ?? 'extensions';
    const requestId = crypto.randomUUID();
    const request = new Promise<SecretLease>((resolve, reject) => {
      this.pending.set(requestId, { sessionId, resolve, reject });
    });
    this.emit({
      requestId,
      sessionId,
      name: reference.key,
      description: context.purpose
    });
    return request;
  }

  resolveRequest(requestId: string, value?: string): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    if (!value) pending.reject(unavailable('The user did not provide the requested secret.'));
    else pending.resolve({ value, dispose: () => undefined });
  }

  cancelSession(sessionId: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.sessionId !== sessionId) continue;
      this.pending.delete(requestId);
      pending.reject(unavailable('The session was cancelled.'));
    }
  }

  cancelAll(): void {
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      pending.reject(unavailable('The runtime is shutting down.'));
    }
  }
}
