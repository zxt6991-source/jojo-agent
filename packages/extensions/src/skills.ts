import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseDocument, stringify } from 'yaml';
import { z } from 'zod';
import type { SkillStatus, Tool } from '@desktop-agent/contracts';

const MAX_SKILL_FILES = 500;
const MAX_SCAN_DEPTH = 5;
const MAX_RESOURCE_FILES = 500;
const MAX_SKILL_CHARACTERS = 120_000;
const RESOURCE_DIRECTORY_NAMES = ['scripts', 'templates', 'references'] as const;

type SkillOrigin = SkillStatus['origin'];
type SkillResources = SkillStatus['resources'];

export type SkillDirectory = string | {
  path: string;
  origin: SkillOrigin;
};

export type DiscoveredSkill = SkillStatus & { content: string };

const SkillFrontmatterSchema = z.object({
  name: z.string().trim().min(1, 'Skill frontmatter is missing name.'),
  description: z.string().trim().min(1, 'Skill frontmatter is missing description.')
}).passthrough();

export function userSkillDirectories(homeDirectory = os.homedir()): string[] {
  return [
    path.join(homeDirectory, '.agents', 'skills'),
    path.join(homeDirectory, '.codex', 'skills'),
    path.join(homeDirectory, '.config', 'agents', 'skills')
  ];
}

export function skillId(name: string, fallback = 'skill'): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '') || fallback;
}

export function parseSkillSource(filePath: string, source: string): { id: string; name: string; description: string } {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(source);
  if (!match) throw new Error('SKILL.md must start with YAML frontmatter.');
  const document = parseDocument(match[1] ?? '', { prettyErrors: true, strict: true });
  if (document.errors.length > 0) throw new Error(`Invalid Skill YAML: ${document.errors[0]!.message}`);
  let frontmatter: unknown;
  try {
    frontmatter = document.toJS({ maxAliasCount: 100 });
  } catch (error) {
    throw new Error(`Invalid Skill YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = SkillFrontmatterSchema.safeParse(frontmatter);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid Skill frontmatter.');
  const fallbackId = path.basename(path.dirname(filePath));
  return {
    id: skillId(parsed.data.name, fallbackId),
    name: parsed.data.name,
    description: parsed.data.description
  };
}

export function createSkillSource(name: string, description: string, instructions = ''): string {
  const frontmatter = stringify({ name: name.trim(), description: description.trim() }, { lineWidth: 0 }).trimEnd();
  const body = instructions.trim() || `# ${name.trim()}\n\nDescribe when and how to use this skill.`;
  return `---\n${frontmatter}\n---\n\n${body}\n`;
}

async function collectRelativeFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(current: string, relative: string, depth: number): Promise<void> {
    if (files.length >= MAX_RESOURCE_FILES || depth > MAX_SCAN_DEPTH) return;
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); }
    catch { return; }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const nextRelative = relative ? path.join(relative, entry.name) : entry.name;
      if (entry.isFile()) files.push(nextRelative);
      else if (entry.isDirectory()) await visit(path.join(current, entry.name), nextRelative, depth + 1);
      if (files.length >= MAX_RESOURCE_FILES) break;
    }
  }
  await visit(directory, '', 0);
  return files;
}

async function discoverResources(rootPath: string): Promise<SkillResources> {
  const entries = await Promise.all(RESOURCE_DIRECTORY_NAMES.map((name) => collectRelativeFiles(path.join(rootPath, name))));
  return {
    scripts: entries[0]!,
    templates: entries[1]!,
    references: entries[2]!
  };
}

async function parseSkillFile(
  filePath: string,
  source: string,
  disabled: Set<string>,
  origin: SkillOrigin
): Promise<DiscoveredSkill> {
  const metadata = parseSkillSource(filePath, source);
  const rootPath = path.dirname(filePath);
  return {
    ...metadata,
    path: filePath,
    rootPath,
    origin,
    resources: await discoverResources(rootPath),
    enabled: !disabled.has(metadata.id),
    content: source.slice(0, MAX_SKILL_CHARACTERS)
  };
}

async function collectSkillFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(current: string, depth: number): Promise<void> {
    if (files.length >= MAX_SKILL_FILES || depth > MAX_SCAN_DEPTH) return;
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); }
    catch { return; }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    if (entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md')) {
      files.push(path.join(current, 'SKILL.md'));
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      await visit(path.join(current, entry.name), depth + 1);
      if (files.length >= MAX_SKILL_FILES) break;
    }
  }
  await visit(directory, 0);
  return files.slice(0, MAX_SKILL_FILES);
}

const ORIGIN_PRIORITY: Record<SkillOrigin, number> = {
  project: 4,
  user: 3,
  custom: 2,
  default: 1
};

function normalizeDirectories(directories: SkillDirectory[]): Array<{ path: string; origin: SkillOrigin; order: number }> {
  const unique = new Map<string, { path: string; origin: SkillOrigin; order: number }>();
  directories.forEach((entry, order) => {
    const descriptor = typeof entry === 'string' ? { path: entry, origin: 'custom' as const } : entry;
    const resolved = path.resolve(descriptor.path);
    const existing = unique.get(resolved);
    if (!existing || ORIGIN_PRIORITY[descriptor.origin] > ORIGIN_PRIORITY[existing.origin]) {
      unique.set(resolved, { path: resolved, origin: descriptor.origin, order });
    }
  });
  return [...unique.values()].sort((left, right) =>
    ORIGIN_PRIORITY[right.origin] - ORIGIN_PRIORITY[left.origin] || left.order - right.order
  );
}

export async function discoverSkills(directories: SkillDirectory[], disabledIds: string[] = []): Promise<DiscoveredSkill[]> {
  const disabled = new Set(disabledIds);
  const normalized = normalizeDirectories(directories);
  const fileGroups = await Promise.all(normalized.map(async (directory) => ({
    ...directory,
    files: await collectSkillFiles(directory.path)
  })));
  const skills: DiscoveredSkill[] = [];
  const winners = new Map<string, DiscoveredSkill>();
  for (const group of fileGroups) {
    for (const filePath of group.files) {
      try {
        const info = await stat(filePath);
        if (!info.isFile() || info.size > MAX_SKILL_CHARACTERS * 4) throw new Error('Skill file is too large.');
        const skill = await parseSkillFile(filePath, await readFile(filePath, 'utf8'), disabled, group.origin);
        const winner = winners.get(skill.id);
        if (winner) {
          skills.push({ ...skill, enabled: false, overriddenBy: winner.path });
        } else {
          winners.set(skill.id, skill);
          skills.push(skill);
        }
      } catch (error) {
        skills.push({
          id: `invalid-${skills.length + 1}`,
          name: path.basename(path.dirname(filePath)),
          description: 'Invalid skill',
          path: filePath,
          rootPath: path.dirname(filePath),
          origin: group.origin,
          resources: { scripts: [], templates: [], references: [] },
          enabled: false,
          error: error instanceof Error ? error.message : String(error),
          content: ''
        });
      }
    }
  }
  return skills;
}

const LoadSkillInput = z.object({ skillId: z.string().min(1) });

function resourceCatalog(skill: DiscoveredSkill): string {
  return RESOURCE_DIRECTORY_NAMES.map((name) => {
    const files = skill.resources[name];
    const directory = path.join(skill.rootPath, name);
    return files.length > 0
      ? `- ${name}: ${directory}\n  Files: ${files.join(', ')}`
      : `- ${name}: ${directory} (empty or absent)`;
  }).join('\n');
}

export function createSkillTool(skills: DiscoveredSkill[]): Tool | null {
  const enabled = skills.filter((skill) => skill.enabled && !skill.error && !skill.overriddenBy);
  if (enabled.length === 0) return null;
  const byId = new Map(enabled.map((skill) => [skill.id, skill]));
  const catalog = enabled.map((skill) => `${skill.id}: ${skill.description}`).join('\n').slice(0, 16_000);
  return {
    definition: {
      name: 'load_skill',
      description: `Load the full instructions for one installed skill when its description matches the task. Load before following it. Available skills:\n${catalog}`,
      inputSchema: {
        type: 'object',
        properties: { skillId: { type: 'string', enum: enabled.map((skill) => skill.id) } },
        required: ['skillId'],
        additionalProperties: false
      }
    },
    async execute(input) {
      const { skillId } = LoadSkillInput.parse(input);
      const skill = byId.get(skillId);
      if (!skill) return { callId: '', ok: false, code: 'skill_not_found', content: `Unknown or disabled skill: ${skillId}` };
      return {
        callId: '',
        ok: true,
        content: `[Skill: ${skill.name}]\nRoot: ${skill.rootPath}\nSKILL.md: ${skill.path}\n\nResource directories (resolve relative paths from Root):\n${resourceCatalog(skill)}\n\n${skill.content}\n\n[End skill]`
      };
    }
  };
}
