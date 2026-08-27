import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import type { AgentProfileDefinition, AgentProfileSource } from './profile-registry.js';
import { AgentProfileRegistry } from './profile-registry.js';

const MAX_PROFILE_FILES = 64;
const MAX_PROFILE_BYTES = 64 * 1024;

const ProfileFrontmatterSchema = z.object({
  name: z.string().trim().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/u),
  description: z.string().trim().min(1).max(2_000),
  readOnly: z.boolean().default(true),
  allowedTools: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
  deniedTools: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  maxIterations: z.number().int().min(1).max(20).optional(),
  timeoutMs: z.number().int().min(5_000).max(300_000).optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional()
}).strict();

export type AgentProfileLoadWarning = {
  filePath: string;
  message: string;
};

export type AgentProfileLoadResult = {
  profiles: AgentProfileDefinition[];
  warnings: AgentProfileLoadWarning[];
};

function parseProfile(
  sourceText: string,
  filePath: string,
  source: Exclude<AgentProfileSource, 'builtin' | 'extension'>
): AgentProfileDefinition {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(sourceText);
  if (!match) throw new Error('Agent profile must start with YAML frontmatter.');
  const document = parseDocument(match[1] ?? '', { prettyErrors: true, strict: true });
  if (document.errors.length > 0) throw new Error(document.errors[0]!.message);
  const parsed = ProfileFrontmatterSchema.safeParse(document.toJS({ maxAliasCount: 0 }));
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid agent profile frontmatter.');
  const systemPrompt = (match[2] ?? '').trim();
  if (!systemPrompt) throw new Error('Agent profile body must contain a system prompt.');
  const expectedName = path.basename(filePath, path.extname(filePath));
  if (parsed.data.name !== expectedName) {
    throw new Error(`Profile name must match its file name: expected ${expectedName}.`);
  }
  return {
    name: parsed.data.name,
    description: parsed.data.description,
    readOnly: parsed.data.readOnly,
    source,
    sourcePath: filePath,
    systemPrompt,
    ...(parsed.data.allowedTools ? { allowedTools: parsed.data.allowedTools } : {}),
    ...(parsed.data.deniedTools ? { deniedTools: parsed.data.deniedTools } : {}),
    ...(parsed.data.model ? { model: parsed.data.model } : {}),
    ...(parsed.data.maxIterations !== undefined ? { maxIterations: parsed.data.maxIterations } : {}),
    ...(parsed.data.timeoutMs !== undefined ? { timeoutMs: parsed.data.timeoutMs } : {}),
    ...(parsed.data.outputSchema ? { outputSchema: parsed.data.outputSchema } : {})
  };
}

export async function loadAgentProfileDirectory(
  directory: string,
  source: Exclude<AgentProfileSource, 'builtin' | 'extension'>
): Promise<AgentProfileLoadResult> {
  let entries: import('node:fs').Dirent<string>[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { profiles: [], warnings: [] };
    throw error;
  }
  const candidates = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .sort((left, right) => left.name.localeCompare(right.name));
  const warnings: AgentProfileLoadWarning[] = [];
  if (candidates.length > MAX_PROFILE_FILES) {
    warnings.push({ filePath: directory, message: `Only the first ${MAX_PROFILE_FILES} agent profiles are loaded.` });
  }
  const profiles: AgentProfileDefinition[] = [];
  for (const entry of candidates.slice(0, MAX_PROFILE_FILES)) {
    const filePath = path.join(directory, entry.name);
    try {
      const metadata = await stat(filePath);
      if (metadata.size > MAX_PROFILE_BYTES) throw new Error(`Agent profile exceeds ${MAX_PROFILE_BYTES} bytes.`);
      profiles.push(parseProfile(await readFile(filePath, 'utf8'), filePath, source));
    } catch (error) {
      warnings.push({ filePath, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { profiles, warnings };
}

export async function reloadAgentProfiles(
  registry: AgentProfileRegistry,
  options: { userDirectory?: string; projectRoot?: string }
): Promise<AgentProfileLoadWarning[]> {
  const warnings: AgentProfileLoadWarning[] = [];
  if (options.userDirectory) {
    const loaded = await loadAgentProfileDirectory(options.userDirectory, 'user');
    registry.replaceUserProfiles(loaded.profiles);
    warnings.push(...loaded.warnings);
  }
  if (options.projectRoot) {
    const loaded = await loadAgentProfileDirectory(path.join(options.projectRoot, '.jojo', 'agents'), 'project');
    registry.replaceProjectProfiles(options.projectRoot, loaded.profiles);
    warnings.push(...loaded.warnings);
  }
  return warnings;
}
