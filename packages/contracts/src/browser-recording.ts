import { z } from 'zod';

export const BROWSER_RECORDING_VERSION = 1;
export const BROWSER_RECORDING_ID_PATTERN = /^(?:r[1-9][0-9]*|[a-z0-9][a-z0-9-]{0,79})$/u;
export const BROWSER_RECORDING_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/u;
export const BROWSER_RECORDING_PARAM_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/u;

export const BrowserRecordingFingerprintSchema = z.object({
  selector: z.string().trim().min(1).max(2_000).optional(),
  tag: z.string().trim().min(1).max(100),
  role: z.string().trim().min(1).max(200).optional(),
  name: z.string().trim().min(1).max(500).optional(),
  id: z.string().trim().min(1).max(200).optional(),
  testId: z.string().trim().min(1).max(200).optional(),
  fieldName: z.string().trim().min(1).max(200).optional(),
  inputType: z.string().trim().min(1).max(100).optional(),
  placeholder: z.string().trim().min(1).max(500).optional(),
  href: z.string().trim().min(1).max(2_000).optional()
});
export type BrowserRecordingFingerprint = z.infer<typeof BrowserRecordingFingerprintSchema>;

export const BrowserRecordingParamSchema = z.object({
  name: z.string().regex(BROWSER_RECORDING_PARAM_NAME_PATTERN),
  description: z.string().trim().min(1).max(500).optional(),
  type: z.enum(['string', 'number', 'boolean']).default('string'),
  secret: z.boolean().default(false)
});
export type BrowserRecordingParam = z.infer<typeof BrowserRecordingParamSchema>;

export const BrowserRecordingStepSchema = z.object({
  action: z.enum(['open', 'wait', 'scroll', 'click', 'hover', 'type', 'press', 'select', 'back', 'reload']),
  url: z.string().min(1).max(4_096).optional(),
  selector: z.string().trim().min(1).max(2_000).optional(),
  state: z.enum(['attached', 'detached', 'visible', 'hidden']).optional(),
  timeoutMs: z.number().int().min(100).max(30_000).optional(),
  deltaX: z.number().int().min(-100_000).max(100_000).optional(),
  deltaY: z.number().int().min(-100_000).max(100_000).optional(),
  text: z.string().max(100_000).optional(),
  submit: z.boolean().optional(),
  key: z.string().min(1).max(32).optional(),
  values: z.array(z.string().max(1_000)).min(1).max(20).optional(),
  fingerprint: BrowserRecordingFingerprintSchema.optional()
});
export type BrowserRecordingStep = z.infer<typeof BrowserRecordingStepSchema>;

export const BrowserRecordingDocumentSchema = z.object({
  version: z.literal(BROWSER_RECORDING_VERSION),
  id: z.string().regex(BROWSER_RECORDING_SLUG_PATTERN),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(2_000).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime().optional(),
  params: z.array(BrowserRecordingParamSchema).max(50).default([]),
  steps: z.array(BrowserRecordingStepSchema).max(100)
}).superRefine((document, context) => {
  const names = new Set<string>();
  for (const [index, param] of document.params.entries()) {
    if (names.has(param.name)) {
      context.addIssue({ code: 'custom', message: `Duplicate recording param: ${param.name}`, path: ['params', index, 'name'] });
    }
    names.add(param.name);
  }
});
export type BrowserRecordingDocument = z.infer<typeof BrowserRecordingDocumentSchema>;

export const BrowserRecordingIdSchema = z.string().regex(BROWSER_RECORDING_ID_PATTERN);

export function migrateBrowserRecording(raw: unknown): BrowserRecordingDocument {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Browser recording must be a YAML object.');
  }
  const document = raw as Record<string, unknown>;
  if (document.version === undefined) document.version = BROWSER_RECORDING_VERSION;
  if (document.version !== BROWSER_RECORDING_VERSION) {
    throw new Error(`Unsupported browser recording version: ${String(document.version)}`);
  }
  return BrowserRecordingDocumentSchema.parse(document);
}

export function slugifyBrowserRecordingName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 80);
  return slug || 'workflow';
}
