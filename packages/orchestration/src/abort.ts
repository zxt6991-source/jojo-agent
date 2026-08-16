export type LinkedAbortController = {
  controller: AbortController;
  dispose(): void;
};

export function createLinkedAbortController(signals: AbortSignal[]): LinkedAbortController {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  for (const signal of signals) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    controller,
    dispose: () => {
      for (const signal of signals) signal.removeEventListener('abort', onAbort);
    }
  };
}

export function abortError(message = 'Operation cancelled.'): DOMException {
  return new DOMException(message, 'AbortError');
}
