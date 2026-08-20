import path from 'node:path';
import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '@desktop-agent/contracts';
import type { DiscoveredSkill } from './skills.js';

const SkillNameSchema = z.string().trim().min(1).max(120).refine(
  (value) => !value.startsWith('-'),
  'Skill names cannot start with a hyphen.'
);
const InstallSkillInput = z.object({
  source: z.string().trim().min(1).max(2_048).refine(
    (value) => !value.startsWith('-'),
    'Skill sources cannot start with a hyphen.'
  ),
  skills: z.array(SkillNameSchema).max(100).optional()
});

export type SkillInstallCommandRunner = (
  args: string[],
  context: ToolContext
) => Promise<ToolResult>;

export type InstallSkillToolOptions = {
  runCommand: SkillInstallCommandRunner;
  refreshSkills: () => Promise<DiscoveredSkill[]>;
};

function insideDirectory(filePath: string, directory: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(filePath));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function projectSkills(skills: DiscoveredSkill[], workingDirectory: string): DiscoveredSkill[] {
  const directory = path.join(workingDirectory, '.agents', 'skills');
  return skills.filter((skill) => skill.enabled && !skill.error && insideDirectory(skill.path, directory));
}

export function createInstallSkillTool(options: InstallSkillToolOptions): Tool {
  return {
    replay: 'never',
    definition: {
      name: 'install_skill',
      description: 'Install Agent Skills into the current workspace. Use this instead of terminal for `npx skills add`. The command is non-interactive and automatically targets the universal agent with copied files. Newly installed skills become available during this turn.',
      inputSchema: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            description: 'Skill source accepted by the skills CLI, for example owner/repository or a Git URL.'
          },
          skills: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional skill names to install from a repository containing multiple skills.'
          }
        },
        required: ['source'],
        additionalProperties: false
      }
    },
    async execute(input, context) {
      if (!context.approved) {
        return { callId: '', ok: false, code: 'permission_denied', content: 'Skill installation requires approval.' };
      }

      const parsed = InstallSkillInput.parse(input);
      const before = projectSkills(await options.refreshSkills(), context.workingDirectory);
      const args = ['--yes', 'skills', 'add', parsed.source];
      for (const skill of parsed.skills ?? []) args.push('--skill', skill);
      args.push('--yes', '--agent', 'universal', '--copy');

      const commandResult = await options.runCommand(args, context);
      if (!commandResult.ok) return commandResult;

      const after = projectSkills(await options.refreshSkills(), context.workingDirectory);
      if (after.length === 0) {
        return {
          callId: '',
          ok: false,
          code: 'skill_install_unverified',
          content: 'The skills CLI exited successfully, but no valid SKILL.md was found under .agents/skills.'
        };
      }

      const requested = new Set(parsed.skills ?? []);
      const missing = [...requested].filter((name) => !after.some((skill) => skill.id === name || skill.name === name));
      if (missing.length > 0) {
        return {
          callId: '',
          ok: false,
          code: 'skill_install_unverified',
          content: `The command completed, but these requested skills were not discovered: ${missing.join(', ')}.`
        };
      }

      const previousPaths = new Set(before.map((skill) => skill.path));
      const installed = after.filter((skill) => !previousPaths.has(skill.path));
      const available = (installed.length > 0 ? installed : after).map((skill) => skill.id);
      return {
        callId: '',
        ok: true,
        content: `${installed.length > 0 ? 'Installed' : 'Verified'} Skills: ${available.join(', ')}. They are available to load now.`
      };
    }
  };
}
