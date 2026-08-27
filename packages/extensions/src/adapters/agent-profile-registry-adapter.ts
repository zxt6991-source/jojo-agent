import type { AgentProfileContribution, ContributionOwner, Disposable } from '@desktop-agent/contracts';
import type { AgentProfileRegistry } from '@desktop-agent/orchestration';

export class AgentProfileRegistryAdapter {
  private readonly owners = new Map<string, string>();

  constructor(private readonly registry: AgentProfileRegistry) {}

  get version(): number { return this.registry.revision; }

  register(owner: ContributionOwner, contribution: AgentProfileContribution): Disposable {
    const existingOwner = this.owners.get(contribution.id);
    if (existingOwner || this.registry.list().some((profile) => profile.name === contribution.id)) {
      throw new Error(`extension_agent_profile_duplicate_id: ${contribution.id}`);
    }
    const disposable = this.registry.register({
      name: contribution.id,
      source: owner.source === 'builtin' ? 'builtin' : 'extension',
      description: contribution.description,
      systemPrompt: contribution.systemPrompt,
      readOnly: contribution.readOnly,
      ...(contribution.allowedTools ? { allowedTools: [...contribution.allowedTools] } : {}),
      ...(contribution.deniedTools ? { deniedTools: [...contribution.deniedTools] } : {}),
      ...(contribution.model ? { model: contribution.model } : {}),
      ...(contribution.maxIterations !== undefined ? { maxIterations: contribution.maxIterations } : {}),
      ...(contribution.timeoutMs !== undefined ? { timeoutMs: contribution.timeoutMs } : {}),
      ...(contribution.outputSchema ? { outputSchema: structuredClone(contribution.outputSchema) } : {})
    });
    this.owners.set(contribution.id, owner.id);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.owners.get(contribution.id) === owner.id) this.owners.delete(contribution.id);
        disposable.dispose();
      }
    };
  }
}
