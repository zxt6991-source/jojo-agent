import type { ContributionOwner, Disposable, Tool } from '@desktop-agent/contracts';
import type { ContextContributionRegistry } from '../api/context-registry.js';
import type { ToolContributionRegistry } from '../api/tool-registry.js';
import { createSkillTool, type DiscoveredSkill } from '../skills.js';

const SKILL_OWNER: ContributionOwner = { id: 'skills', version: '1', source: 'builtin' };

export type SkillContributionAdapterOptions = {
  loadedSkillIds?: Set<string>;
  installTool?: Tool;
};

export class SkillContributionAdapter implements Disposable {
  private disposables: Disposable[] = [];

  constructor(
    private readonly tools: ToolContributionRegistry,
    private readonly contexts: ContextContributionRegistry,
    private readonly owner: ContributionOwner = SKILL_OWNER
  ) {}

  sync(skills: DiscoveredSkill[], options: SkillContributionAdapterOptions = {}): void {
    this.dispose();
    const skillTool = createSkillTool(skills, { loadedSkillIds: options.loadedSkillIds ?? new Set() });
    if (skillTool) this.disposables.push(this.tools.register(this.owner, {
      id: skillTool.definition.name,
      tool: skillTool
    }));
    if (options.installTool) this.disposables.push(this.tools.register(this.owner, {
      id: options.installTool.definition.name,
      tool: options.installTool
    }));
    const enabled = skills.filter((skill) => skill.enabled);
    this.disposables.push(this.contexts.register(this.owner, {
      id: 'catalog',
      contribute: async () => ({
        blocks: enabled.map((skill, index) => ({
          id: `skill-${index + 1}`,
          kind: 'resource' as const,
          content: `${skill.name}: ${skill.description}`,
          priority: 20,
          source: this.owner.id,
          cachePolicy: 'session' as const
        }))
      })
    }));
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0).reverse()) disposable.dispose();
  }
}
