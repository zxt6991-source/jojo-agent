import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserRecordingDocument, BrowserRecordingStep } from '@desktop-agent/contracts';
import { BrowserAutomationError } from '../errors';
import type {
  BrowserReplayJournalEntry,
  BrowserReplayJournalPort,
  BrowserReplayJournalState
} from '../ports/browser-replay-journal';

const RUN_ID_PATTERN = /^brun_[a-zA-Z0-9_-]{8,100}$/u;
const JOURNAL_STATES = new Set<BrowserReplayJournalState>([
  'step_started', 'step_effect_dispatched', 'step_heal_proposed', 'step_heal_verified',
  'step_verified', 'step_failed', 'run_completed'
]);
const STEP_ACTIONS = new Set<BrowserRecordingStep['action']>([
  'navigate', 'click', 'hover', 'type', 'press', 'select', 'upload', 'download', 'wait', 'extract',
  'scroll', 'back', 'reload'
]);
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;

export type BrowserReplayResumeState = {
  verifiedStepIds: ReadonlySet<string>;
  outputs: Record<string, NonNullable<BrowserReplayJournalEntry['output']>['value']>;
  unsafePendingStep?: BrowserReplayJournalEntry;
};

export class BrowserReplayJournalStore implements BrowserReplayJournalPort {
  constructor(private readonly directory: string) {}

  async append(entry: BrowserReplayJournalEntry): Promise<void> {
    assertRunId(entry.runId);
    validateEntry(entry);
    await mkdir(this.directory, { recursive: true });
    await appendFile(this.filePath(entry.runId), `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  async read(runId: string): Promise<BrowserReplayJournalEntry[]> {
    assertRunId(runId);
    let text: string;
    try { text = await readFile(this.filePath(runId), 'utf8'); }
    catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_JOURNAL_BYTES) {
      throw new BrowserAutomationError('browser_replay_failed', `Browser replay journal ${runId} exceeds the size limit.`);
    }
    return text.split('\n').filter(Boolean).map((line, index) => {
      try {
        const entry = JSON.parse(line) as BrowserReplayJournalEntry;
        validateEntry(entry);
        if (entry.runId !== runId) throw new Error('run id mismatch');
        return entry;
      } catch (error) {
        throw new BrowserAutomationError(
          'browser_replay_failed',
          `Browser replay journal ${runId} is invalid at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  async list(recordingId?: string): Promise<BrowserReplayJournalEntry[]> {
    let names: string[];
    try { names = await readdir(this.directory); }
    catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
    const entries: BrowserReplayJournalEntry[] = [];
    for (const name of names.sort()) {
      const runId = name.replace(/\.jsonl$/u, '');
      if (`${runId}.jsonl` !== name || !RUN_ID_PATTERN.test(runId)) continue;
      for (const entry of await this.read(runId).catch(() => [])) {
        if (!recordingId || entry.recordingId === recordingId) entries.push(entry);
      }
    }
    return entries.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  }

  private filePath(runId: string): string { return path.join(this.directory, `${runId}.jsonl`); }
}

export function isReplaySafeBrowserStep(step: Pick<BrowserRecordingStep, 'action'>): boolean {
  return step.action === 'wait' || step.action === 'extract';
}

export function analyzeBrowserReplayResume(
  recording: Pick<BrowserRecordingDocument, 'id' | 'revision'>,
  entries: readonly BrowserReplayJournalEntry[]
): BrowserReplayResumeState {
  const verifiedStepIds = new Set<string>();
  const lastVerifiedPosition = new Map<string, number>();
  const lastEffect = new Map<string, { position: number; entry: BrowserReplayJournalEntry }>();
  const outputs: Record<string, NonNullable<BrowserReplayJournalEntry['output']>['value']> = {};
  for (const [position, entry] of entries.entries()) {
    if (entry.recordingId !== recording.id || entry.revision !== recording.revision) {
      throw new BrowserAutomationError(
        'browser_replay_failed',
        `Replay journal was created for ${entry.recordingId} revision ${entry.revision}, not ${recording.id} revision ${recording.revision}.`
      );
    }
    if (entry.state === 'step_verified') {
      verifiedStepIds.add(entry.stepId);
      lastVerifiedPosition.set(entry.stepId, position);
      if (entry.output) outputs[entry.output.name] = entry.output.value;
    } else if (entry.state === 'step_effect_dispatched') {
      lastEffect.set(entry.stepId, { position, entry });
    }
  }
  const unsafePendingStep = [...lastEffect.values()]
    .filter(({ position, entry }) => position > (lastVerifiedPosition.get(entry.stepId) ?? -1))
    .map(({ entry }) => entry)
    .find((entry) => !isReplaySafeBrowserStep(entry));
  return { verifiedStepIds, outputs, ...(unsafePendingStep ? { unsafePendingStep } : {}) };
}

export function createBrowserReplayJournalEntry(input: Omit<BrowserReplayJournalEntry, 'timestamp'>): BrowserReplayJournalEntry {
  return { ...input, timestamp: new Date().toISOString() };
}

function assertRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new BrowserAutomationError('browser_replay_failed', `Invalid browser replay run id: ${runId}`);
  }
}

function validateEntry(entry: BrowserReplayJournalEntry): void {
  if (!entry || typeof entry !== 'object') throw new Error('entry must be an object');
  assertRunId(entry.runId);
  if (!entry.recordingId || entry.recordingId.length > 80) throw new Error('invalid recording id');
  if (!Number.isInteger(entry.revision) || entry.revision < 1) throw new Error('invalid recording revision');
  if (!entry.stepId || entry.stepId.length > 160) throw new Error('invalid step id');
  if (!Number.isInteger(entry.stepIndex) || entry.stepIndex < 0) throw new Error('invalid step index');
  if (!STEP_ACTIONS.has(entry.action)) throw new Error('invalid step action');
  if (!JOURNAL_STATES.has(entry.state)) throw new Error('invalid journal state');
  if (!Number.isFinite(Date.parse(entry.timestamp))) throw new Error('invalid timestamp');
  if (entry.attempt !== undefined && (!Number.isInteger(entry.attempt) || entry.attempt < 1)) throw new Error('invalid attempt');
  if (entry.selector !== undefined && (!entry.selector.trim() || entry.selector.length > 2_000)) throw new Error('invalid selector');
  if (entry.confidence !== undefined && (!Number.isFinite(entry.confidence) || entry.confidence < 0 || entry.confidence > 1)) {
    throw new Error('invalid confidence');
  }
  if (entry.output !== undefined) {
    if (entry.state !== 'step_verified') throw new Error('journal output requires step_verified');
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(entry.output.name)) throw new Error('invalid output name');
    const value = entry.output.value;
    if (!value || typeof value !== 'object' || !['file', 'string', 'json'].includes(value.type)) throw new Error('invalid output value');
    if (value.type === 'file' && (typeof value.path !== 'string' || value.path.length > 4_096)) throw new Error('invalid file output');
    if (value.type === 'string' && (typeof value.value !== 'string' || value.value.length > 100_000)) throw new Error('invalid string output');
    let serialized: string;
    try { serialized = JSON.stringify(value); } catch { throw new Error('output value must be JSON serializable'); }
    if (Buffer.byteLength(serialized) > 256 * 1024) throw new Error('output value exceeds the size limit');
  }
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
