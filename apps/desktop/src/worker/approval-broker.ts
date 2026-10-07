import { ServerApprovalBroker, type ServerStateStore } from '@desktop-agent/app-service';
import type { ApprovalRequest } from '@desktop-agent/contracts';

/** Desktop preparation can precede Runtime session creation; all approvals use the shared durable lifecycle. */
export class DesktopApprovalBroker extends ServerApprovalBroker {
  constructor(private readonly state: ServerStateStore) {
    super({ store: state.approvals });
  }

  override async requestSessionApproval(request: ApprovalRequest, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    await this.state.sessions.ensureActive({ sessionId: request.sessionId });
    return super.requestSessionApproval(request, signal);
  }
}
