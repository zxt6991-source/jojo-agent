import { parse, stringify } from 'yaml';
import { migrateBrowserRecording, type BrowserRecordingDocument } from '@desktop-agent/contracts';
import { BrowserAutomationError } from '../errors';
import { finalizeBrowserRecording, hasValidBrowserRecordingHash } from './hash';

export function parseBrowserRecordingYaml(text: string): BrowserRecordingDocument {
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (error) {
    throw new Error(`Invalid browser recording YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  const rawVersion = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>).version ?? 1
    : undefined;
  const recording = migrateBrowserRecording(parsed);
  if (rawVersion === 1) return finalizeBrowserRecording(recording);
  if (!recording.contentHash) {
    throw new BrowserAutomationError('browser_recording_invalid', `Browser Recording V2 ${recording.id} is missing contentHash.`);
  }
  if (!hasValidBrowserRecordingHash(recording)) {
    throw new BrowserAutomationError('browser_recording_invalid', `Browser recording hash is invalid: ${recording.id}`);
  }
  return recording;
}

export function stringifyBrowserRecording(document: BrowserRecordingDocument): string {
  return stringify(finalizeBrowserRecording(document), { lineWidth: 0, indent: 2 }).trimEnd() + '\n';
}
