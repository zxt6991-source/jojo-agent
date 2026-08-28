import type { ProtocolError } from '@desktop-agent/server-protocol';

export class ProtocolFailure extends Error {
  constructor(readonly protocol: ProtocolError) {
    super(protocol.message);
    this.name = 'ProtocolFailure';
  }
}

export function asProtocolError(error: unknown, requestId?: string): ProtocolError {
  if (error instanceof ProtocolFailure) {
    return { ...error.protocol, ...(requestId ? { requestId } : {}) };
  }
  const message = error instanceof Error ? error.message : String(error);
  const match = /^([a-z][a-z0-9_]+)(?::\s*(.*))?$/u.exec(message);
  const rawCode = match?.[1] ?? 'internal_error';
  const code = mapCode(rawCode);
  const safeMessage = code === 'internal_error'
    ? 'An internal server error occurred.'
    : match?.[2] || defaultMessage(code);
  return { code, message: safeMessage, ...(requestId ? { requestId } : {}) };
}

export function protocolStatus(code: string): number {
  if (code === 'unauthorized') return 401;
  if (code === 'forbidden' || code === 'workspace_not_allowed' || code === 'scope_not_allowed') return 403;
  if (['not_found', 'run_not_found', 'approval_not_found'].includes(code)) return 404;
  if (code === 'session_locked') return 423;
  if ([
    'session_busy', 'lane_busy', 'idempotency_conflict', 'idempotency_in_progress', 'revision_conflict',
    'approval_already_resolved', 'approval_interrupted', 'run_transition_conflict'
  ].includes(code)) return 409;
  if (code === 'payload_too_large') return 413;
  if (code === 'rate_limited') return 429;
  if (['runtime_unavailable', 'runtime_interrupted'].includes(code)) return 503;
  if (code === 'internal_error') return 500;
  return 400;
}

function mapCode(code: string): string {
  if (code === 'runtime_session_not_found' || code === 'runtime_lane_not_found') return 'not_found';
  if (code === 'runtime_lane_busy') return 'lane_busy';
  if (code === 'runtime_closed') return 'runtime_unavailable';
  if (code === 'approval_not_found') return 'approval_not_found';
  if (code === 'run_not_found') return 'run_not_found';
  const publicCodes = new Set([
    'protocol_version_unsupported', 'unauthorized', 'forbidden', 'not_found', 'invalid_request',
    'session_busy', 'lane_busy', 'session_locked', 'idempotency_conflict', 'idempotency_in_progress',
    'approval_required',
    'approval_expired', 'run_not_found', 'run_cancelled', 'runtime_unavailable', 'runtime_interrupted',
    'rate_limited', 'payload_too_large', 'scope_not_allowed', 'workspace_not_allowed',
    'provider_error', 'internal_error', 'revision_conflict', 'approval_already_resolved',
    'approval_interrupted', 'run_transition_conflict'
  ]);
  return publicCodes.has(code) ? code : 'internal_error';
}

function defaultMessage(code: string): string {
  return code.split('_').join(' ');
}
