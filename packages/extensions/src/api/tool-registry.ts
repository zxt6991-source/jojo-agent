import type {
  ContributionOwner,
  Disposable,
  ExtensionPermission,
  Tool,
  ToolContribution
} from '@desktop-agent/contracts';

const LOCAL_TOOL_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/u;

export type RegisteredToolContribution = {
  id: string;
  localId: string;
  owner: ContributionOwner;
  permissions: readonly ExtensionPermission[];
  tool: Tool;
};

function exposedToolId(owner: ContributionOwner, localId: string): string {
  return owner.source === 'builtin' ? localId : `${owner.id}:${localId}`;
}

export class ToolContributionRegistry {
  private readonly registrations = new Map<string, RegisteredToolContribution>();
  private registryVersion = 0;

  get version(): number { return this.registryVersion; }

  register(
    owner: ContributionOwner,
    contribution: ToolContribution,
    permissions: readonly ExtensionPermission[] = []
  ): Disposable {
    if (!LOCAL_TOOL_ID.test(contribution.id)) throw new Error(`extension_tool_invalid_id: ${contribution.id}`);
    const id = exposedToolId(owner, contribution.id);
    if (this.registrations.has(id)) throw new Error(`extension_tool_duplicate_id: ${id}`);
    const tool: Tool = {
      ...contribution.tool,
      definition: { ...contribution.tool.definition, name: id },
      ...(contribution.tool.effects ? { effects: [...contribution.tool.effects] } : {})
    };
    const registration: RegisteredToolContribution = {
      id,
      localId: contribution.id,
      owner: { ...owner },
      permissions: [...permissions],
      tool
    };
    this.registrations.set(id, registration);
    this.registryVersion += 1;
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.registrations.get(id) === registration) {
          this.registrations.delete(id);
          this.registryVersion += 1;
        }
      }
    };
  }

  resolve(): Tool[] {
    return [...this.registrations.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(({ tool }) => tool);
  }

  snapshot(): RegisteredToolContribution[] {
    return [...this.registrations.values()].map((registration) => ({
      ...registration,
      owner: { ...registration.owner },
      permissions: [...registration.permissions],
      tool: {
        ...registration.tool,
        definition: { ...registration.tool.definition },
        ...(registration.tool.effects ? { effects: [...registration.tool.effects] } : {})
      }
    }));
  }
}
