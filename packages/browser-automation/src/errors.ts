export type BrowserAutomationErrorCode =
  | 'browser_session_open_failed'
  | 'browser_page_not_found'
  | 'browser_navigation_blocked'
  | 'browser_domain_violation'
  | 'browser_target_not_found'
  | 'browser_target_ambiguous'
  | 'browser_target_relocation_failed'
  | 'browser_action_failed'
  | 'browser_wait_timeout'
  | 'browser_verify_failed'
  | 'browser_download_failed'
  | 'browser_upload_denied'
  | 'browser_recording_not_found'
  | 'browser_recording_invalid'
  | 'browser_recording_untrusted'
  | 'browser_recording_revision_conflict'
  | 'browser_replay_failed'
  | 'browser_replay_resume_unsafe'
  | 'browser_recovery_exhausted'
  | 'browser_heal_unavailable'
  | 'browser_heal_failed'
  | 'browser_heal_rejected'
  | 'browser_secret_missing'
  | 'browser_permission_denied';

export class BrowserAutomationError extends Error {
  constructor(
    readonly code: BrowserAutomationErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>
  ) {
    super(message);
    this.name = 'BrowserAutomationError';
  }
}
