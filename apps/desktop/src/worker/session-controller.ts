import { SessionMetadataService, type SessionMetadataServiceOptions } from '@desktop-agent/app-service';
import type { WorkerCommand, WorkerMessage } from '@desktop-agent/contracts';

export function createSessionController(options: SessionMetadataServiceOptions & {
  ready: Promise<unknown>;
  post(message: WorkerMessage): void;
}) {
  const service = new SessionMetadataService(options);
  return {
    service,
    handle(command: WorkerCommand): boolean {
      if (command.type !== 'session.metadata') return false;
      void options.ready.then(() => service.execute(command.operation)).then(
        result => options.post({ type: 'session.metadata.result', requestId: command.requestId, ok: true, result }),
        error => options.post({ type: 'session.metadata.result', requestId: command.requestId, ok: false, error: error instanceof Error ? error.message : String(error) })
      );
      return true;
    }
  };
}
