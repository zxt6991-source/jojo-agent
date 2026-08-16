import type { WorkflowRetryPolicy, WorkflowStepErrorCode } from '@desktop-agent/contracts';
import { abortError } from '../abort.js';

export function shouldRetryWorkflowStep(
  policy: WorkflowRetryPolicy | undefined,
  errorCode: WorkflowStepErrorCode | undefined,
  attemptsThisRun: number
): boolean {
  return Boolean(policy
    && errorCode
    && attemptsThisRun < policy.maxAttempts
    && policy.retryOn.includes(errorCode as WorkflowRetryPolicy['retryOn'][number]));
}

export function waitForRetryBackoff(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  if (milliseconds === 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
