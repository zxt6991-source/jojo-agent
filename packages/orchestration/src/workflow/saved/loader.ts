import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { WorkflowDefinitionSchema } from '@desktop-agent/contracts';
import { SavedWorkflowRegistry, savedWorkflowFromDefinition } from './registry.js';
import {
  MAX_SAVED_WORKFLOW_BYTES,
  MAX_SAVED_WORKFLOW_FILES,
  SAVED_WORKFLOW_NAME_PATTERN,
  type SavedWorkflow,
  type SavedWorkflowLoadResult,
  type SavedWorkflowLoadWarning,
  type SavedWorkflowSource
} from './types.js';

function isYamlWorkflowFile(name: string): boolean {
  return name.endsWith('.yaml') || name.endsWith('.yml');
}

function workflowFileStem(fileName: string): string {
  return fileName.replace(/\.ya?ml$/u, '');
}

async function assertInsideDirectory(directory: string, filePath: string): Promise<void> {
  const root = await realpath(directory);
  const resolved = await realpath(filePath);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (resolved !== root && !resolved.startsWith(prefix)) {
    throw new Error('Saved workflow path is outside the workflows directory.');
  }
}

function parseSavedWorkflow(sourceText: string, filePath: string, source: Exclude<SavedWorkflowSource, 'builtin'>): SavedWorkflow {
  let candidate: unknown;
  try {
    candidate = parseYaml(sourceText, { maxAliasCount: 0 });
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
  const parsed = WorkflowDefinitionSchema.safeParse(candidate);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid saved workflow definition.');
  const expectedName = workflowFileStem(path.basename(filePath));
  if (!SAVED_WORKFLOW_NAME_PATTERN.test(parsed.data.name)) {
    throw new Error(`Saved workflow name must be a lowercase slug: ${parsed.data.name}`);
  }
  if (parsed.data.name !== expectedName) {
    throw new Error(`Saved workflow name must match its file name: expected ${expectedName}.`);
  }
  return savedWorkflowFromDefinition(parsed.data, source, filePath);
}

export async function loadSavedWorkflowDirectory(
  directory: string,
  source: Exclude<SavedWorkflowSource, 'builtin'>
): Promise<SavedWorkflowLoadResult> {
  let entries: import('node:fs').Dirent<string>[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { workflows: [], warnings: [] };
    throw error;
  }
  const candidates = entries
    .filter((entry) => entry.isFile() && entry.name === path.basename(entry.name) && isYamlWorkflowFile(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  const warnings: SavedWorkflowLoadWarning[] = [];
  if (candidates.length > MAX_SAVED_WORKFLOW_FILES) {
    warnings.push({ filePath: directory, message: `Only the first ${MAX_SAVED_WORKFLOW_FILES} saved workflows are loaded.` });
  }
  const workflows: SavedWorkflow[] = [];
  for (const entry of candidates.slice(0, MAX_SAVED_WORKFLOW_FILES)) {
    const filePath = path.join(directory, entry.name);
    try {
      await assertInsideDirectory(directory, filePath);
      const metadata = await stat(filePath);
      if (metadata.size > MAX_SAVED_WORKFLOW_BYTES) throw new Error(`Saved workflow exceeds ${MAX_SAVED_WORKFLOW_BYTES} bytes.`);
      workflows.push(parseSavedWorkflow(await readFile(filePath, 'utf8'), filePath, source));
    } catch (error) {
      warnings.push({ filePath, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { workflows, warnings };
}

export async function reloadSavedWorkflows(
  registry: SavedWorkflowRegistry,
  options: { userDirectory?: string; projectRoot?: string }
): Promise<SavedWorkflowLoadWarning[]> {
  const warnings: SavedWorkflowLoadWarning[] = [];
  if (options.userDirectory) {
    const loaded = await loadSavedWorkflowDirectory(options.userDirectory, 'user');
    registry.replaceUserWorkflows(loaded.workflows);
    warnings.push(...loaded.warnings);
  }
  if (options.projectRoot) {
    const loaded = await loadSavedWorkflowDirectory(path.join(options.projectRoot, '.jojo', 'workflows'), 'project');
    registry.replaceProjectWorkflows(options.projectRoot, loaded.workflows);
    warnings.push(...loaded.warnings);
  }
  return warnings;
}
