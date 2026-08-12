import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { SkillStatus, Tool } from '@desktop-agent/contracts';

const MAX_SKILL_FILES = 500;
const MAX_SCAN_DEPTH = 5;
const MAX_SKILL_CHARACTERS = 120_000;

export type DiscoveredSkill = SkillStatus & { content: string };

export function userSkillDirectories(homeDirectory = os.homedir()): string[] {
  return [
    path.join(homeDirectory, '.agents', 'skills'),
    path.join(homeDirectory, '.codex', 'skills'),
    path.join(homeDirectory, '.config', 'agents', 'skills')
  ];
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function frontmatterValue(frontmatter: string, key: string): string | undefined {
  const lines = frontmatter.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const match = new RegExp(`^${key}:\\s*(.*)$`, 'u').exec(lines[index] ?? '');
    if (!match) continue;
    const initial = match[1]?.trim() ?? '';
    if (initial && initial !== '|' && initial !== '>') return unquote(initial);
    const continuation: string[] = [];
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      if (!/^\s+/u.test(line)) break;
      continuation.push(line.trim());
    }
    return continuation.join(initial === '>' ? ' ' : '\n').trim();
  }
  return undefined;
}

function parseSkillFile(filePath: string, source: string, disabled: Set<string>): DiscoveredSkill {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/u.exec(source);
  if (!match) throw new Error('SKILL.md must start with YAML frontmatter.');
  const name = frontmatterValue(match[1] ?? '', 'name')?.trim();
  const description = frontmatterValue(match[1] ?? '', 'description')?.trim();
  if (!name) throw new Error('Skill frontmatter is missing name.');
  if (!description) throw new Error('Skill frontmatter is missing description.');
  const fallbackId = path.basename(path.dirname(filePath));
  const id = name.toLowerCase().replace(/[^a-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '') || fallbackId;
  return {
    id,
    name,
    description,
    path: filePath,
    enabled: !disabled.has(id),
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
    if (entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md')) {
      files.push(path.join(current, 'SKILL.md'));
      return;
    }
    await Promise.all(entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => visit(path.join(current, entry.name), depth + 1)));
  }
  await visit(directory, 0);
  return files.slice(0, MAX_SKILL_FILES).sort();
}

export async function discoverSkills(directories: string[], disabledIds: string[] = []): Promise<DiscoveredSkill[]> {
  const disabled = new Set(disabledIds);
  const normalized = Array.from(new Set(directories.map((directory) => path.resolve(directory))));
  const files = (await Promise.all(normalized.map(collectSkillFiles))).flat();
  const skills: DiscoveredSkill[] = [];
  const ids = new Set<string>();
  for (const filePath of files) {
    try {
      const info = await stat(filePath);
      if (!info.isFile() || info.size > MAX_SKILL_CHARACTERS * 4) throw new Error('Skill file is too large.');
      const skill = parseSkillFile(filePath, await readFile(filePath, 'utf8'), disabled);
      if (ids.has(skill.id)) {
        skills.push({ ...skill, enabled: false, error: `Duplicate skill id: ${skill.id}` });
      } else {
        ids.add(skill.id);
        skills.push(skill);
      }
    } catch (error) {
      skills.push({
        id: `invalid-${skills.length + 1}`,
        name: path.basename(path.dirname(filePath)),
        description: 'Invalid skill',
        path: filePath,
        enabled: false,
        error: error instanceof Error ? error.message : String(error),
        content: ''
      });
    }
  }
  return skills;
}

const LoadSkillInput = z.object({ skillId: z.string().min(1) });

export function createSkillTool(skills: DiscoveredSkill[]): Tool | null {
  const enabled = skills.filter((skill) => skill.enabled && !skill.error);
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
        content: `[Skill: ${skill.name}]\nSource: ${skill.path}\n\n${skill.content}\n\n[End skill]`
      };
    }
  };
}
