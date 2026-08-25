import { randomUUID } from 'node:crypto';
import type {
  BrowserRecordingDocument,
  BrowserRecordingStep,
  BrowserHealProposal,
  BrowserTarget,
  BrowserVerify,
  BrowserWaitPolicy
} from '@desktop-agent/contracts';
import { BrowserAutomationError } from '../errors';
import type { BrowserPage, BrowserSession, ResolvedBrowserTarget } from '../ports/browser-driver';
import type { BrowserHealingPort } from '../ports/browser-healing-port';
import type { BrowserRecordingStorePort } from '../ports/browser-recording-store';
import type { BrowserReplayJournalPort } from '../ports/browser-replay-journal';
import { applyRecordingParams, type RecordingParamValue } from '../recording/params';
import { domainAllowsHost, isRetryableBrowserStepError } from '../security/browser-security';
import {
  analyzeBrowserReplayResume,
  createBrowserReplayJournalEntry,
  isReplaySafeBrowserStep
} from './replay-journal';

export type BrowserOutputValue =
  | { type: 'file'; path: string }
  | { type: 'string'; value: string }
  | { type: 'json'; value: unknown };

export type BrowserReplayProgress =
  | { type: 'run_start'; runId: string; resumed: boolean }
  | { type: 'step_start'; index: number; total: number; label: string }
  | { type: 'step_skipped'; index: number; reason: 'already_verified' }
  | { type: 'step_wait'; reason: string }
  | { type: 'relocated'; oldSelector?: string; newSelector?: string }
  | { type: 'recovery'; strategy: string; attempt: number }
  | { type: 'heal_start'; round: number }
  | { type: 'heal_success'; selector: string }
  | { type: 'download'; path: string }
  | { type: 'step_success'; index: number }
  | { type: 'step_failed'; index: number; error: string };

export type BrowserReplayStepResult = {
  stepId: string;
  index: number;
  success: boolean;
  attempts: number;
  relocated: boolean;
  durationMs: number;
  error?: string;
};

export type BrowserHealRecord = {
  stepId: string;
  previousSelector?: string;
  selector: string;
  confidence: number;
  reason?: string;
  persisted: boolean;
  persistenceError?: string;
};

export type BrowserReplayResult = {
  runId: string;
  recordingId: string;
  success: boolean;
  steps: BrowserReplayStepResult[];
  outputs: Record<string, BrowserOutputValue>;
  finalUrl?: string;
  relocated: boolean;
  selfHealed: boolean;
  healRecords?: BrowserHealRecord[];
  error?: string;
};

export type BrowserReplayOptions = {
  params?: Record<string, RecordingParamValue>;
  secrets?: Record<string, string>;
  maxRetries?: number;
  retryDelayMs?: number;
  journal?: BrowserReplayJournalPort;
  runId?: string;
  resume?: boolean;
  confirmUnsafeResume?: boolean;
  healingPort?: BrowserHealingPort;
  maxHealRounds?: number;
  minimumHealConfidence?: number;
  recordingStore?: BrowserRecordingStorePort;
  persistHeals?: boolean;
  onProgress?: (progress: BrowserReplayProgress) => void;
};

export class BrowserReplayEngine {
  async replay(
    recording: BrowserRecordingDocument,
    session: BrowserSession,
    options: BrowserReplayOptions = {},
    signal: AbortSignal = new AbortController().signal
  ): Promise<BrowserReplayResult> {
    const runId = options.runId ?? `brun_${randomUUID()}`;
    const stepResults: BrowserReplayStepResult[] = [];
    const outputs: Record<string, BrowserOutputValue> = {};
    const healRecords: BrowserHealRecord[] = [];
    const healedSelectors = new Map<number, string>();
    let relocated = false;
    let page = await session.activePage();
    try {
      assertNotAborted(signal);
      let verifiedStepIds: ReadonlySet<string> = new Set();
      if (options.resume) {
        if (!options.journal || !options.runId) {
          throw new BrowserAutomationError('browser_replay_failed', 'Replay resume requires both a journal and an existing run id.');
        }
        const entries = await options.journal.read(runId);
        if (entries.length === 0) throw new BrowserAutomationError('browser_replay_failed', `Browser replay run does not exist: ${runId}`);
        const resume = analyzeBrowserReplayResume(recording, entries);
        Object.assign(outputs, resume.outputs);
        if (resume.unsafePendingStep && !options.confirmUnsafeResume) {
          throw new BrowserAutomationError(
            'browser_replay_resume_unsafe',
            `Step ${resume.unsafePendingStep.stepId} may already have produced an external effect. Resume requires explicit confirmation.`,
            { runId, stepId: resume.unsafePendingStep.stepId }
          );
        }
        const verified = new Set(resume.verifiedStepIds);
        if (resume.unsafePendingStep) verified.delete(resume.unsafePendingStep.stepId);
        verifiedStepIds = verified;
      } else if (options.journal && options.runId && (await options.journal.read(runId)).length > 0) {
        throw new BrowserAutomationError('browser_replay_failed', `Browser replay run already exists: ${runId}. Use resume to continue it.`);
      }
      options.onProgress?.({ type: 'run_start', runId, resumed: options.resume === true });
      if (recording.start?.url && !verifiedStepIds.has('$start')) {
        assertAllowedRecordingUrl(recording.start.url, recording.domains);
        await appendJournal(options.journal, {
          runId, recordingId: recording.id, revision: recording.revision, stepId: '$start',
          stepIndex: 0, action: 'navigate', state: 'step_started', attempt: 1
        });
        try {
          await appendJournal(options.journal, {
            runId, recordingId: recording.id, revision: recording.revision, stepId: '$start',
            stepIndex: 0, action: 'navigate', state: 'step_effect_dispatched', attempt: 1
          });
          await page.navigate(recording.start.url, signal);
          await appendJournal(options.journal, {
            runId, recordingId: recording.id, revision: recording.revision, stepId: '$start',
            stepIndex: 0, action: 'navigate', state: 'step_verified', attempt: 1
          });
        } catch (error) {
          await appendJournal(options.journal, {
            runId, recordingId: recording.id, revision: recording.revision, stepId: '$start',
            stepIndex: 0, action: 'navigate', state: 'step_failed', attempt: 1
          });
          throw error;
        }
      }
      for (const [index, sourceStep] of recording.steps.entries()) {
        const step = applyRecordingParams(sourceStep, recording, options.params ?? {}, options.secrets ?? {});
        if (verifiedStepIds.has(step.id)) {
          stepResults.push({ stepId: step.id, index: index + 1, success: true, attempts: 0, relocated: false, durationMs: 0 });
          options.onProgress?.({ type: 'step_skipped', index: index + 1, reason: 'already_verified' });
          continue;
        }
        const startedAt = Date.now();
        let attempts = 0;
        let healRounds = 0;
        let activeStep = step;
        let proposedHeal: Omit<BrowserHealRecord, 'persisted'> | undefined;
        let stepRelocated = false;
        const pageIdsBefore = new Set((await session.listPages()).map((item) => item.id));
        options.onProgress?.({ type: 'step_start', index: index + 1, total: recording.steps.length, label: step.label ?? step.id });
        try {
          while (true) {
            attempts += 1;
            let effectDispatched = false;
            try {
              assertNotAborted(signal);
              await appendJournal(options.journal, {
                runId, recordingId: recording.id, revision: recording.revision, stepId: step.id,
                stepIndex: index + 1, action: step.action, state: 'step_started', attempt: attempts
              });
              page = await session.activePage();
              const execution = await executeStep(
                page, activeStep, recording.domains, outputs, options.onProgress,
                async () => {
                  await appendJournal(options.journal, {
                    runId, recordingId: recording.id, revision: recording.revision, stepId: step.id,
                    stepIndex: index + 1, action: step.action, state: 'step_effect_dispatched', attempt: attempts
                  });
                  effectDispatched = true;
                },
                signal
              );
              stepRelocated ||= execution.relocated;
              relocated ||= execution.relocated;
              if (activeStep.wait?.newPage) page = await followNewPage(session, pageIdsBefore, activeStep.wait.timeoutMs ?? 15_000, signal);
              await applyWaitPolicy(page, activeStep.wait, options.onProgress, signal);
              await verifyBrowserState(page, activeStep.verify, execution.target, execution.downloadPath, signal);
              await assertCurrentDomain(page, recording.domains);
              await appendJournal(options.journal, {
                runId, recordingId: recording.id, revision: recording.revision, stepId: step.id,
                stepIndex: index + 1, action: step.action, state: 'step_verified', attempt: attempts,
                ...(step.bind && outputs[step.bind] ? { output: { name: step.bind, value: outputs[step.bind]! } } : {})
              });
              break;
            } catch (error) {
              if (attempts <= (options.maxRetries ?? 2) && isReplayRetryable(error)) {
                options.onProgress?.({ type: 'recovery', strategy: 'bounded_retry', attempt: attempts });
                await abortableDelay(Math.min(2_000, (options.retryDelayMs ?? 250) * attempts), signal);
                continue;
              }
              if (!effectDispatched && canSelfHeal(error, activeStep, options, healRounds)) {
                healRounds += 1;
                options.onProgress?.({ type: 'heal_start', round: healRounds });
                const proposal = await proposeBrowserHeal(page, activeStep, options, signal);
                proposedHeal = {
                  stepId: step.id,
                  ...(activeStep.target?.selector ? { previousSelector: activeStep.target.selector } : {}),
                  selector: proposal.selector,
                  confidence: proposal.confidence,
                  ...(proposal.reason ? { reason: proposal.reason } : {})
                };
                await appendJournal(options.journal, {
                  runId, recordingId: recording.id, revision: recording.revision, stepId: step.id,
                  stepIndex: index + 1, action: step.action, state: 'step_heal_proposed', attempt: attempts,
                  selector: proposal.selector, confidence: proposal.confidence
                });
                activeStep = { ...activeStep, target: { ...activeStep.target!, selector: proposal.selector } };
                continue;
              }
              throw error;
            }
          }
          if (proposedHeal) {
            await appendJournal(options.journal, {
              runId, recordingId: recording.id, revision: recording.revision, stepId: step.id,
              stepIndex: index + 1, action: step.action, state: 'step_heal_verified', attempt: attempts,
              selector: proposedHeal.selector, confidence: proposedHeal.confidence
            });
            healRecords.push({ ...proposedHeal, persisted: false });
            healedSelectors.set(index, proposedHeal.selector);
            options.onProgress?.({ type: 'heal_success', selector: proposedHeal.selector });
          }
          stepResults.push({ stepId: step.id, index: index + 1, success: true, attempts, relocated: stepRelocated, durationMs: Date.now() - startedAt });
          options.onProgress?.({ type: 'step_success', index: index + 1 });
        } catch (error) {
          const message = errorMessage(error);
          await appendJournal(options.journal, {
            runId, recordingId: recording.id, revision: recording.revision, stepId: step.id,
            stepIndex: index + 1, action: step.action, state: 'step_failed', attempt: Math.max(1, attempts)
          });
          stepResults.push({ stepId: step.id, index: index + 1, success: false, attempts, relocated: stepRelocated, durationMs: Date.now() - startedAt, error: message });
          options.onProgress?.({ type: 'step_failed', index: index + 1, error: message });
          const finalUrl = await safeUrl(page);
          return replayResult({ runId, recordingId: recording.id, success: false, steps: stepResults, outputs, finalUrl, relocated, healRecords, error: message });
        }
      }
      await verifyBrowserState(page, recording.end, undefined, undefined, signal);
      await assertCurrentDomain(page, recording.domains);
      if (healRecords.length > 0 && options.recordingStore && options.persistHeals !== false) {
        try {
          await options.recordingStore.save({
            ...recording,
            steps: recording.steps.map((step, index) => {
              const selector = healedSelectors.get(index);
              return selector ? { ...step, target: { ...step.target!, selector } } : step;
            })
          }, { expectedRevision: recording.revision, expectedHash: recording.contentHash });
          for (const record of healRecords) record.persisted = true;
        } catch (error) {
          const persistenceError = errorMessage(error);
          for (const record of healRecords) record.persistenceError = persistenceError;
        }
      }
      const lastStep = recording.steps.at(-1);
      if (lastStep) await appendJournal(options.journal, {
        runId, recordingId: recording.id, revision: recording.revision, stepId: lastStep.id,
        stepIndex: recording.steps.length, action: lastStep.action, state: 'run_completed'
      });
      const finalUrl = await safeUrl(page);
      return replayResult({ runId, recordingId: recording.id, success: true, steps: stepResults, outputs, finalUrl, relocated, healRecords });
    } catch (error) {
      const finalUrl = await safeUrl(page);
      return replayResult({
        runId, recordingId: recording.id, success: false, steps: stepResults, outputs, finalUrl,
        relocated, healRecords, error: errorMessage(error)
      });
    }
  }
}

async function executeStep(
  page: BrowserPage,
  step: BrowserRecordingStep,
  domains: string[],
  outputs: Record<string, BrowserOutputValue>,
  onProgress: BrowserReplayOptions['onProgress'],
  beforeEffect: () => Promise<void>,
  signal: AbortSignal
): Promise<{ target?: ResolvedBrowserTarget; relocated: boolean; downloadPath?: string }> {
  if (step.action === 'navigate') {
    assertAllowedRecordingUrl(step.url!, domains);
    await beforeEffect();
    await page.navigate(step.url!, signal);
    return { relocated: false };
  }
  const target = step.target ? await requireTarget(page, step.target, onProgress, signal) : undefined;
  if (!isReplaySafeBrowserStep(step)) await beforeEffect();
  if (step.action === 'click') await page.click(target!, signal);
  else if (step.action === 'hover') await page.hover(target!, signal);
  else if (step.action === 'type') await page.type(target!, step.value!, signal);
  else if (step.action === 'press') await page.press(target, step.key!, signal);
  else if (step.action === 'select') await page.select(target!, step.values!, signal);
  else if (step.action === 'upload') {
    if (!page.upload) throw new BrowserAutomationError('browser_upload_denied', 'This browser driver does not support uploads.');
    await page.upload(target!, step.paths!, signal);
  } else if (step.action === 'download') {
    if (!page.download) throw new BrowserAutomationError('browser_download_failed', 'This browser driver does not support deterministic downloads.');
    const result = await page.download(target!, signal);
    if (step.bind) outputs[step.bind] = { type: 'file', path: result.path };
    onProgress?.({ type: 'download', path: result.path });
    return { ...(target ? { target } : {}), relocated: target?.relocated ?? false, downloadPath: result.path };
  } else if (step.action === 'extract') {
    if (!page.extract) throw new BrowserAutomationError('browser_action_failed', 'This browser driver does not support extraction.');
    const value = await page.extract(target!, signal);
    if (step.bind) outputs[step.bind] = typeof value === 'string' ? { type: 'string', value } : { type: 'json', value };
  } else if (step.action === 'wait') {
    onProgress?.({ type: 'step_wait', reason: step.condition?.type ?? 'wait' });
    await page.wait(step.condition!, step.timeoutMs, signal);
  } else if (step.action === 'scroll') {
    if (!page.scroll) throw new BrowserAutomationError('browser_action_failed', 'This browser driver does not support legacy scroll steps.');
    await page.scroll(target, step.deltaX ?? 0, step.deltaY ?? 600, signal);
  } else if (step.action === 'back') {
    if (!page.back) throw new BrowserAutomationError('browser_action_failed', 'This browser driver does not support legacy back steps.');
    await page.back(signal);
  } else if (step.action === 'reload') {
    if (!page.reload) throw new BrowserAutomationError('browser_action_failed', 'This browser driver does not support legacy reload steps.');
    await page.reload(signal);
  }
  return { ...(target ? { target } : {}), relocated: target?.relocated ?? false };
}

async function requireTarget(
  page: BrowserPage,
  target: BrowserTarget,
  onProgress: BrowserReplayOptions['onProgress'],
  signal: AbortSignal
): Promise<ResolvedBrowserTarget> {
  const resolved = await page.resolveTarget(target, undefined, signal);
  if (!resolved) throw new BrowserAutomationError('browser_target_not_found', `Browser target was not found: ${target.selector ?? target.fingerprint?.accessibleName ?? target.fingerprint?.tag ?? 'unknown'}`);
  if (resolved.relocated) onProgress?.({
    type: 'relocated',
    ...(target.selector ? { oldSelector: target.selector } : {}),
    newSelector: resolved.selector
  });
  return resolved;
}

async function applyWaitPolicy(
  page: BrowserPage,
  wait: BrowserWaitPolicy | undefined,
  onProgress: BrowserReplayOptions['onProgress'],
  signal: AbortSignal
): Promise<void> {
  if (!wait) return;
  const timeout = wait.timeoutMs;
  if (wait.networkIdle) {
    onProgress?.({ type: 'step_wait', reason: 'network_idle' });
    await page.wait({ type: 'network_idle', idleMs: 500 }, timeout, signal);
  }
  if (wait.domStableMs) {
    onProgress?.({ type: 'step_wait', reason: 'dom_stable' });
    await page.wait({ type: 'dom_stable', stableMs: wait.domStableMs }, timeout, signal);
  }
  if (wait.elementVisible) {
    onProgress?.({ type: 'step_wait', reason: 'element_visible' });
    await page.wait({ type: 'element_state', target: wait.elementVisible, state: 'visible' }, timeout, signal);
  }
}

async function followNewPage(
  session: BrowserSession,
  previousPageIds: ReadonlySet<string>,
  timeoutMs: number,
  signal: AbortSignal
): Promise<BrowserPage> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    assertNotAborted(signal);
    const opened = (await session.listPages()).find((page) => !previousPageIds.has(page.id));
    if (opened) {
      await session.selectPage(opened.id);
      return session.activePage();
    }
    await abortableDelay(100, signal);
  }
  throw new BrowserAutomationError('browser_wait_timeout', `Timed out after ${timeoutMs} ms waiting for a new browser page.`);
}

export async function verifyBrowserState(
  page: BrowserPage,
  verify: BrowserVerify | undefined,
  stepTarget: ResolvedBrowserTarget | undefined,
  downloadPath: string | undefined,
  signal: AbortSignal
): Promise<void> {
  if (!verify) return;
  const url = await page.getUrl();
  if (verify.urlContains && !url.includes(verify.urlContains)) failVerify(`URL does not contain ${verify.urlContains}.`);
  if (verify.urlMatches) {
    let pattern: RegExp;
    try { pattern = new RegExp(verify.urlMatches, 'u'); } catch { failVerify('urlMatches is not a valid regular expression.'); }
    if (!pattern!.test(url)) failVerify(`URL does not match ${verify.urlMatches}.`);
  }
  if (verify.exists && !await page.resolveTarget(verify.exists, { allowMissing: true }, signal)) failVerify('Expected element does not exist.');
  if (verify.notExists && await page.resolveTarget(verify.notExists, { allowMissing: true }, signal)) failVerify('Unexpected element exists.');
  if (verify.textContains) {
    const snapshot = await page.read(undefined, signal);
    if (!snapshot.text?.includes(verify.textContains)) failVerify(`Page text does not contain ${verify.textContains}.`);
  }
  if (verify.valueEquals !== undefined || verify.valueNotEmpty) {
    if (!stepTarget || !page.getValue) failVerify('Driver cannot verify the target value.');
    const value = await page.getValue!(stepTarget!, signal);
    if (verify.valueEquals !== undefined && value !== verify.valueEquals) failVerify('Target value does not equal the expected value.');
    if (verify.valueNotEmpty && value.length === 0) failVerify('Target value is empty.');
  }
  if (verify.downloadCompleted && !downloadPath) failVerify('Expected download did not complete.');
}

function failVerify(message: string): never { throw new BrowserAutomationError('browser_verify_failed', message); }

function assertAllowedRecordingUrl(value: string, domains: string[]): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new BrowserAutomationError('browser_navigation_blocked', `Invalid browser URL: ${value}`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new BrowserAutomationError('browser_navigation_blocked', `Browser navigation is blocked: ${value}`);
  }
  if (!domains.some((domain) => domainAllowsHost(domain, url.hostname))) {
    throw new BrowserAutomationError('browser_domain_violation', `Domain ${url.hostname} is not declared by the recording.`);
  }
}

async function assertCurrentDomain(page: BrowserPage, domains: string[]): Promise<void> {
  assertAllowedRecordingUrl(await page.getUrl(), domains);
}

function isReplayRetryable(error: unknown): boolean {
  if (error instanceof BrowserAutomationError) return error.code === 'browser_target_not_found';
  const message = error instanceof Error ? error.message : String(error);
  return /(?:Element|Editable element|Focusable element|Select element) not found|could not be safely relocated/iu.test(message)
    && isRetryableBrowserStepError(error);
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Browser replay aborted.');
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const finish = () => { signal.removeEventListener('abort', onAbort); resolve(); };
    const timeout = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason instanceof Error ? signal.reason : new Error('Browser replay aborted.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function safeUrl(page: BrowserPage): Promise<string | undefined> {
  try { return await page.getUrl(); } catch { return undefined; }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function canSelfHeal(
  error: unknown,
  step: BrowserRecordingStep,
  options: BrowserReplayOptions,
  completedRounds: number
): boolean {
  if (!options.healingPort || !step.target || completedRounds >= (options.maxHealRounds ?? 1)) return false;
  if (!['click', 'hover', 'type', 'press', 'select', 'upload', 'download', 'extract'].includes(step.action)) return false;
  if (error instanceof BrowserAutomationError) {
    return ['browser_target_not_found', 'browser_target_ambiguous', 'browser_target_relocation_failed'].includes(error.code);
  }
  return /target.*(?:not found|ambiguous|relocat)|(?:Element|Editable element|Focusable element|Select element) not found/iu
    .test(errorMessage(error));
}

async function proposeBrowserHeal(
  page: BrowserPage,
  step: BrowserRecordingStep,
  options: BrowserReplayOptions,
  signal: AbortSignal
): Promise<BrowserHealProposal> {
  const snapshot = await page.read({
    maxNodes: 300,
    ...(step.target?.frame ? { frame: step.target.frame } : {})
  }, signal);
  const candidates = (snapshot.elements ?? []).filter((candidate) => candidate.visible).slice(0, 300);
  let proposal: BrowserHealProposal;
  try {
    proposal = await options.healingPort!.heal({
      action: step.action,
      ...(step.target?.selector ? { failedSelector: step.target.selector } : {}),
      ...(step.target?.fingerprint ? { fingerprint: step.target.fingerprint } : {}),
      url: snapshot.url,
      candidates
    }, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    throw new BrowserAutomationError('browser_heal_failed', `Browser self-heal failed: ${errorMessage(error)}`);
  }
  const minimumConfidence = options.minimumHealConfidence ?? 0.8;
  if (proposal.confidence < minimumConfidence) {
    throw new BrowserAutomationError('browser_heal_rejected', `Browser heal confidence ${proposal.confidence} is below ${minimumConfidence}.`);
  }
  if (candidates.filter((candidate) => candidate.selector === proposal.selector).length !== 1) {
    throw new BrowserAutomationError('browser_heal_rejected', 'Browser healer proposed a selector outside the unique DOM candidate set.');
  }
  return {
    selector: proposal.selector,
    confidence: proposal.confidence,
    ...(proposal.reason ? { reason: proposal.reason } : {})
  };
}

function replayResult(input: {
  runId: string;
  recordingId: string;
  success: boolean;
  steps: BrowserReplayStepResult[];
  outputs: Record<string, BrowserOutputValue>;
  finalUrl: string | undefined;
  relocated: boolean;
  healRecords: BrowserHealRecord[];
  error?: string;
}): BrowserReplayResult {
  return {
    runId: input.runId,
    recordingId: input.recordingId,
    success: input.success,
    steps: input.steps,
    outputs: input.outputs,
    ...(input.finalUrl ? { finalUrl: input.finalUrl } : {}),
    relocated: input.relocated,
    selfHealed: input.healRecords.length > 0,
    ...(input.healRecords.length > 0 ? { healRecords: input.healRecords } : {}),
    ...(input.error ? { error: input.error } : {})
  };
}

async function appendJournal(
  journal: BrowserReplayJournalPort | undefined,
  entry: Parameters<typeof createBrowserReplayJournalEntry>[0]
): Promise<void> {
  if (journal) await journal.append(createBrowserReplayJournalEntry(entry));
}
