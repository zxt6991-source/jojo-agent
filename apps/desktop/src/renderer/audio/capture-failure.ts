import type { SpeechCaptureHandle, SpeechErrorCode } from '@desktop-agent/contracts';

/** Local callback only. Full identity fences delayed failures from older turns. */
export interface CaptureFailure {
  handle?: SpeechCaptureHandle;
  code?: SpeechErrorCode;
  message: string;
}
