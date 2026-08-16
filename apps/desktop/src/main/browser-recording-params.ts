import {
  BROWSER_RECORDING_PARAM_NAME_PATTERN,
  type BrowserRecordingDocument,
  type BrowserRecordingParam,
  type BrowserRecordingStep
} from '@desktop-agent/contracts';

const TEMPLATE = /\{\{([a-zA-Z_][a-zA-Z0-9_]{0,63})\}\}/gu;
const PARAM_FIELDS = ['url', 'text', 'selector', 'filename'] as const;

export type RecordingParamValue = string | number | boolean;

export function browserSecretEnvName(paramName: string): string {
  return `JOJO_BROWSER_SECRET_${paramName.replace(/[^a-zA-Z0-9]+/gu, '_').toUpperCase()}`;
}

export function listedRecordingParams(steps: BrowserRecordingStep[], declared: BrowserRecordingParam[] = []): BrowserRecordingParam[] {
  const names = new Set(declared.map((param) => param.name));
  const params = [...declared];
  for (const name of collectTemplateNames(steps)) {
    if (names.has(name)) continue;
    names.add(name);
    params.push({ name, type: 'string', secret: false });
  }
  return params;
}

export function applyRecordingParams(
  step: BrowserRecordingStep,
  document: BrowserRecordingDocument,
  supplied: Record<string, RecordingParamValue>,
  secrets: Record<string, string>
): BrowserRecordingStep {
  const values = resolveParamValues(document, supplied, secrets);
  const next: BrowserRecordingStep = { ...step, ...(step.values ? { values: [...step.values] } : {}) };
  for (const field of PARAM_FIELDS) {
    const current = (next as Record<string, unknown>)[field];
    if (typeof current === 'string') (next as Record<string, unknown>)[field] = substitute(current, values);
  }
  if (next.values) next.values = next.values.map((value) => substitute(value, values));
  return next;
}

export function resolveParamValues(
  document: BrowserRecordingDocument,
  supplied: Record<string, RecordingParamValue>,
  secrets: Record<string, string>
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const param of document.params) {
    if (param.secret) {
      if (Object.hasOwn(supplied, param.name)) {
        throw new Error(`Secret recording param ${param.name} cannot be supplied by the model. Set ${browserSecretEnvName(param.name)} or enter it when prompted.`);
      }
      const secret = secrets[param.name];
      if (secret === undefined || secret === '') {
        throw new Error(`Missing secret recording param ${param.name}.`);
      }
      resolved[param.name] = secret;
      continue;
    }
    const value = Object.hasOwn(supplied, param.name) ? supplied[param.name] : undefined;
    if (value === undefined) {
      throw new Error(`Missing recording param ${param.name}.`);
    }
    if (param.type === 'number' && typeof value !== 'number' && !/^-?\d+(?:\.\d+)?$/u.test(String(value))) {
      throw new Error(`Recording param ${param.name} must be a number.`);
    }
    if (param.type === 'boolean' && typeof value !== 'boolean' && value !== 'true' && value !== 'false') {
      throw new Error(`Recording param ${param.name} must be a boolean.`);
    }
    resolved[param.name] = String(value);
  }
  return resolved;
}

export function secretEnvValues(params: BrowserRecordingParam[], env: NodeJS.Dict<string> = process.env): Record<string, string> {
  const values: Record<string, string> = {};
  for (const param of params) {
    if (!param.secret) continue;
    const envValue = env[browserSecretEnvName(param.name)];
    if (envValue) values[param.name] = envValue;
  }
  return values;
}

function collectTemplateNames(steps: BrowserRecordingStep[]): string[] {
  const names = new Set<string>();
  for (const step of steps) {
    for (const field of PARAM_FIELDS) {
      const current = (step as Record<string, unknown>)[field];
      if (typeof current === 'string') addTemplateNames(current, names);
    }
    for (const value of step.values ?? []) addTemplateNames(value, names);
  }
  return [...names];
}

function addTemplateNames(value: string, names: Set<string>): void {
  TEMPLATE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TEMPLATE.exec(value))) {
    const name = match[1];
    if (name && BROWSER_RECORDING_PARAM_NAME_PATTERN.test(name)) names.add(name);
  }
}

function substitute(value: string, params: Record<string, string>): string {
  return value.replace(TEMPLATE, (_whole, name: string) => {
    if (!Object.hasOwn(params, name)) throw new Error(`Unknown recording param ${name}.`);
    return params[name]!;
  });
}
