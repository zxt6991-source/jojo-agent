import { z } from 'zod';

export const BROWSER_RECORDING_VERSION = 2;
export const BROWSER_RECORDING_ID_PATTERN = /^(?:r[1-9][0-9]*|[a-z0-9][a-z0-9-]{0,79})$/u;
export const BROWSER_RECORDING_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/u;
export const BROWSER_RECORDING_PARAM_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/u;
export const BROWSER_RECORDING_CONTENT_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export const BrowserFramePathSchema = z.object({
  selectors: z.array(z.string().trim().min(1).max(2_000)).min(1).max(16)
});
export type BrowserFramePath = z.infer<typeof BrowserFramePathSchema>;

export const BrowserRecordingFingerprintSchema = z.object({
  primarySelector: z.string().trim().min(1).max(2_000).optional(),
  alternateSelectors: z.array(z.string().trim().min(1).max(2_000)).max(10).optional(),
  tag: z.string().trim().min(1).max(100),
  role: z.string().trim().min(1).max(200).optional(),
  accessibleName: z.string().trim().min(1).max(500).optional(),
  id: z.string().trim().min(1).max(200).optional(),
  testId: z.string().trim().min(1).max(200).optional(),
  fieldName: z.string().trim().min(1).max(200).optional(),
  inputType: z.string().trim().min(1).max(100).optional(),
  placeholder: z.string().trim().min(1).max(500).optional(),
  href: z.string().trim().min(1).max(2_000).optional(),
  neighborText: z.string().trim().min(1).max(500).optional()
});
export type BrowserRecordingFingerprint = z.infer<typeof BrowserRecordingFingerprintSchema>;

export const BrowserTargetSchema = z.object({
  selector: z.string().trim().min(1).max(2_000).optional(),
  fingerprint: BrowserRecordingFingerprintSchema.optional(),
  frame: BrowserFramePathSchema.optional()
}).refine((target) => Boolean(target.selector || target.fingerprint), {
  message: 'Browser target requires a selector or fingerprint.'
});
export type BrowserTarget = z.infer<typeof BrowserTargetSchema>;

export const BrowserRecordingParamSchema = z.object({
  name: z.string().regex(BROWSER_RECORDING_PARAM_NAME_PATTERN),
  description: z.string().trim().min(1).max(500).optional(),
  type: z.enum(['string', 'number', 'boolean']).default('string'),
  secret: z.boolean().default(false),
  required: z.boolean().default(true)
});
export type BrowserRecordingParam = z.infer<typeof BrowserRecordingParamSchema>;

export const BrowserRecordingOutputSchema = z.object({
  name: z.string().regex(BROWSER_RECORDING_PARAM_NAME_PATTERN),
  description: z.string().trim().min(1).max(500).optional(),
  type: z.enum(['string', 'file', 'json'])
});
export type BrowserRecordingOutput = z.infer<typeof BrowserRecordingOutputSchema>;

export const BrowserVerifySchema = z.object({
  urlContains: z.string().min(1).max(4_096).optional(),
  urlMatches: z.string().min(1).max(2_000).optional(),
  exists: BrowserTargetSchema.optional(),
  notExists: BrowserTargetSchema.optional(),
  textContains: z.string().min(1).max(10_000).optional(),
  valueEquals: z.string().max(100_000).optional(),
  valueNotEmpty: z.boolean().optional(),
  downloadCompleted: z.boolean().optional()
}).refine((verify) => Object.keys(verify).length > 0, { message: 'Browser verification cannot be empty.' });
export type BrowserVerify = z.infer<typeof BrowserVerifySchema>;

export const BrowserWaitConditionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('network_idle'), idleMs: z.number().int().min(100).max(10_000).default(500) }),
  z.object({ type: z.literal('dom_stable'), stableMs: z.number().int().min(100).max(10_000).default(500) }),
  z.object({
    type: z.literal('element_state'),
    target: BrowserTargetSchema,
    state: z.enum(['attached', 'detached', 'visible', 'hidden']).default('visible')
  }),
  z.object({ type: z.literal('url'), contains: z.string().min(1).max(4_096) }),
  z.object({ type: z.literal('delay'), delayMs: z.number().int().min(0).max(30_000) })
]);
export type BrowserWaitCondition = z.infer<typeof BrowserWaitConditionSchema>;

export const BrowserWaitPolicySchema = z.object({
  networkIdle: z.boolean().optional(),
  domStableMs: z.number().int().min(100).max(10_000).optional(),
  elementVisible: BrowserTargetSchema.optional(),
  newPage: z.boolean().optional(),
  timeoutMs: z.number().int().min(100).max(30_000).optional()
}).refine((policy) => Object.keys(policy).length > 0, { message: 'Browser wait policy cannot be empty.' });
export type BrowserWaitPolicy = z.infer<typeof BrowserWaitPolicySchema>;

export const BrowserRecordingActionSchema = z.enum([
  'navigate', 'click', 'hover', 'type', 'press', 'select', 'upload', 'download', 'wait', 'extract',
  // Kept for lossless V1 migration. New recorders should not emit these legacy actions.
  'scroll', 'back', 'reload'
]);

export const BrowserHealCandidateSchema = z.object({
  selector: z.string().trim().min(1).max(2_000),
  tag: z.string().trim().min(1).max(100),
  role: z.string().trim().min(1).max(200).optional(),
  accessibleName: z.string().trim().min(1).max(500).optional(),
  visible: z.boolean()
}).strict();
export type BrowserHealCandidate = z.infer<typeof BrowserHealCandidateSchema>;

export const BrowserHealRequestSchema = z.object({
  action: BrowserRecordingActionSchema,
  failedSelector: z.string().trim().min(1).max(2_000).optional(),
  fingerprint: BrowserRecordingFingerprintSchema.optional(),
  url: z.string().url().max(4_096),
  candidates: z.array(BrowserHealCandidateSchema).max(300)
}).strict();
export type BrowserHealRequest = z.infer<typeof BrowserHealRequestSchema>;

export const BrowserHealProposalSchema = z.object({
  selector: z.string().trim().min(1).max(2_000),
  confidence: z.number().min(0).max(1),
  reason: z.string().trim().min(1).max(1_000).optional(),
  fingerprint: BrowserRecordingFingerprintSchema.optional()
}).strict();
export type BrowserHealProposal = z.infer<typeof BrowserHealProposalSchema>;

export const BrowserRecordingStepSchema = z.object({
  id: z.string().regex(BROWSER_RECORDING_SLUG_PATTERN),
  label: z.string().trim().min(1).max(200).optional(),
  action: BrowserRecordingActionSchema,
  target: BrowserTargetSchema.optional(),
  url: z.string().min(1).max(4_096).optional(),
  value: z.string().max(100_000).optional(),
  values: z.array(z.string().max(1_000)).min(1).max(20).optional(),
  key: z.string().min(1).max(32).optional(),
  paths: z.array(z.string().trim().min(1).max(4_096)).min(1).max(10).optional(),
  condition: BrowserWaitConditionSchema.optional(),
  wait: BrowserWaitPolicySchema.optional(),
  verify: BrowserVerifySchema.optional(),
  bind: z.string().regex(BROWSER_RECORDING_PARAM_NAME_PATTERN).optional(),
  timeoutMs: z.number().int().min(100).max(30_000).optional(),
  deltaX: z.number().int().min(-100_000).max(100_000).optional(),
  deltaY: z.number().int().min(-100_000).max(100_000).optional(),
  submit: z.boolean().optional()
}).superRefine((step, context) => {
  if (step.action === 'navigate' && !step.url) {
    context.addIssue({ code: 'custom', message: 'Navigate step requires url.', path: ['url'] });
  }
  if (['click', 'hover', 'type', 'select', 'upload', 'download', 'extract'].includes(step.action) && !step.target) {
    context.addIssue({ code: 'custom', message: `${step.action} step requires target.`, path: ['target'] });
  }
  if (step.action === 'type' && step.value === undefined) {
    context.addIssue({ code: 'custom', message: 'Type step requires value.', path: ['value'] });
  }
  if (step.action === 'press' && !step.key) {
    context.addIssue({ code: 'custom', message: 'Press step requires key.', path: ['key'] });
  }
  if (step.action === 'select' && !step.values) {
    context.addIssue({ code: 'custom', message: 'Select step requires values.', path: ['values'] });
  }
  if (step.action === 'upload' && !step.paths) {
    context.addIssue({ code: 'custom', message: 'Upload step requires paths.', path: ['paths'] });
  }
  if (step.action === 'wait' && !step.condition) {
    context.addIssue({ code: 'custom', message: 'Wait step requires condition.', path: ['condition'] });
  }
  if (step.bind && !['download', 'extract'].includes(step.action)) {
    context.addIssue({ code: 'custom', message: 'Only download and extract steps can bind outputs.', path: ['bind'] });
  }
});
export type BrowserRecordingStep = z.infer<typeof BrowserRecordingStepSchema>;

export const BrowserRecordingStartSchema = z.object({ url: z.string().url() });

export const BrowserRecordingDocumentSchema = z.object({
  version: z.literal(BROWSER_RECORDING_VERSION),
  id: z.string().regex(BROWSER_RECORDING_SLUG_PATTERN),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(2_000).optional(),
  scope: z.enum(['user', 'project']).default('user'),
  domains: z.array(z.string().trim().min(1).max(253)).max(64).default([]),
  params: z.array(BrowserRecordingParamSchema).max(64).default([]),
  outputs: z.array(BrowserRecordingOutputSchema).max(32).default([]),
  start: BrowserRecordingStartSchema.optional(),
  end: BrowserVerifySchema.optional(),
  steps: z.array(BrowserRecordingStepSchema).max(200),
  revision: z.number().int().positive().default(1),
  contentHash: z.union([z.string().regex(BROWSER_RECORDING_CONTENT_HASH_PATTERN), z.literal('')]).default(''),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).superRefine((document, context) => {
  for (const field of ['params', 'outputs'] as const) {
    const names = new Set<string>();
    for (const [index, item] of document[field].entries()) {
      if (names.has(item.name)) {
        context.addIssue({ code: 'custom', message: `Duplicate recording ${field === 'params' ? 'param' : 'output'}: ${item.name}`, path: [field, index, 'name'] });
      }
      names.add(item.name);
    }
  }
  const stepIds = new Set<string>();
  for (const [index, step] of document.steps.entries()) {
    if (stepIds.has(step.id)) context.addIssue({ code: 'custom', message: `Duplicate recording step id: ${step.id}`, path: ['steps', index, 'id'] });
    stepIds.add(step.id);
    if (step.bind && !document.outputs.some((output) => output.name === step.bind)) {
      context.addIssue({ code: 'custom', message: `Unknown recording output: ${step.bind}`, path: ['steps', index, 'bind'] });
    }
  }
});
export type BrowserRecordingDocument = z.infer<typeof BrowserRecordingDocumentSchema>;

export const BrowserRecordingIdSchema = z.string().regex(BROWSER_RECORDING_ID_PATTERN);

const BrowserRecordingV1FingerprintSchema = z.object({
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

const BrowserRecordingV1Schema = z.object({
  version: z.literal(1).default(1),
  id: z.string().regex(BROWSER_RECORDING_SLUG_PATTERN),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(2_000).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime().optional(),
  params: z.array(BrowserRecordingParamSchema).max(64).default([]),
  steps: z.array(z.object({
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
    fingerprint: BrowserRecordingV1FingerprintSchema.optional()
  })).max(200)
});

/** Parses V2 and losslessly upgrades legacy V1 recordings. */
export function migrateBrowserRecording(raw: unknown): BrowserRecordingDocument {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Browser recording must be a YAML object.');
  const input = raw as Record<string, unknown>;
  const version = input.version ?? 1;
  if (version === BROWSER_RECORDING_VERSION) return BrowserRecordingDocumentSchema.parse(input);
  if (version !== 1) throw new Error(`Unsupported browser recording version: ${String(version)}`);

  const legacy = BrowserRecordingV1Schema.parse({ ...input, version: 1 });
  const updatedAt = legacy.updatedAt ?? legacy.createdAt;
  const steps: BrowserRecordingStep[] = legacy.steps.map((step, index) => {
    const fingerprint = step.fingerprint ? {
      ...(step.fingerprint.selector ? { primarySelector: step.fingerprint.selector } : {}),
      tag: step.fingerprint.tag,
      ...(step.fingerprint.role ? { role: step.fingerprint.role } : {}),
      ...(step.fingerprint.name ? { accessibleName: step.fingerprint.name } : {}),
      ...(step.fingerprint.id ? { id: step.fingerprint.id } : {}),
      ...(step.fingerprint.testId ? { testId: step.fingerprint.testId } : {}),
      ...(step.fingerprint.fieldName ? { fieldName: step.fingerprint.fieldName } : {}),
      ...(step.fingerprint.inputType ? { inputType: step.fingerprint.inputType } : {}),
      ...(step.fingerprint.placeholder ? { placeholder: step.fingerprint.placeholder } : {}),
      ...(step.fingerprint.href ? { href: step.fingerprint.href } : {})
    } : undefined;
    const target = step.selector || fingerprint ? {
      ...(step.selector ? { selector: step.selector } : {}),
      ...(fingerprint ? { fingerprint } : {})
    } : undefined;
    return BrowserRecordingStepSchema.parse({
      id: `step-${index + 1}`,
      action: step.action === 'open' ? 'navigate' : step.action,
      ...(target ? { target } : {}),
      ...(step.url ? { url: step.url } : {}),
      ...(step.text !== undefined ? { value: step.text } : {}),
      ...(step.values ? { values: step.values } : {}),
      ...(step.key ? { key: step.key } : {}),
      ...(step.timeoutMs ? { timeoutMs: step.timeoutMs } : {}),
      ...(step.deltaX !== undefined ? { deltaX: step.deltaX } : {}),
      ...(step.deltaY !== undefined ? { deltaY: step.deltaY } : {}),
      ...(step.submit !== undefined ? { submit: step.submit } : {}),
      ...(step.action === 'wait' && target ? { condition: { type: 'element_state', target, state: step.state ?? 'visible' } } : {})
    });
  });
  const domains = [...new Set(legacy.steps.flatMap((step) => {
    if (step.action !== 'open' || !step.url) return [];
    try { return [new URL(step.url).hostname.toLowerCase()]; } catch { return []; }
  }))];
  return BrowserRecordingDocumentSchema.parse({
    version: 2,
    id: legacy.id,
    name: legacy.name,
    ...(legacy.description ? { description: legacy.description } : {}),
    scope: 'user',
    domains,
    params: legacy.params,
    outputs: [],
    steps,
    revision: 1,
    contentHash: '',
    createdAt: legacy.createdAt,
    updatedAt
  });
}

export function slugifyBrowserRecordingName(name: string): string {
  const slug = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 80);
  return slug || 'workflow';
}
