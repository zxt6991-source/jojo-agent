import type { ContributionOwner, Disposable, ExtensionPermission } from '@desktop-agent/contracts';
import type { ToolContributionRegistry } from '../api/tool-registry.js';
import type { ContextContributionRegistry } from '../api/context-registry.js';
import type { McpManager } from '../mcp-manager.js';

const MCP_OWNER: ContributionOwner = { id: 'mcp', version: '1', source: 'builtin' };

export class McpContributionAdapter implements Disposable {
  private toolDisposables: Disposable[] = [];
  private contextDisposable: Disposable | undefined;

  constructor(
    private readonly manager: McpManager,
    private readonly tools: ToolContributionRegistry,
    private readonly contexts?: ContextContributionRegistry,
    private readonly owner: ContributionOwner = MCP_OWNER,
    private readonly permissions: readonly ExtensionPermission[] = []
  ) {}

  /** Refresh after MCP configure/list_changed notifications to freeze a new tool catalog version. */
  syncTools(context: { contextWindowTokens?: number; maxOutputTokens?: number } = {}): void {
    this.clearTools();
    for (const tool of this.manager.getTools(context)) {
      this.toolDisposables.push(this.tools.register(
        this.owner,
        { id: tool.definition.name, tool },
        this.permissions
      ));
    }
    if (this.contexts && !this.contextDisposable) {
      this.contextDisposable = this.contexts.register(this.owner, {
        id: 'server-instructions',
        contribute: async () => ({
          blocks: this.manager.getInstructions().map((content, index) => ({
            id: `server-${index + 1}`,
            kind: 'instruction' as const,
            content,
            priority: 50,
            source: this.owner.id,
            cachePolicy: 'turn' as const
          }))
        })
      });
    }
  }

  dispose(): void {
    this.clearTools();
    this.contextDisposable?.dispose();
    this.contextDisposable = undefined;
  }

  private clearTools(): void {
    for (const disposable of this.toolDisposables.splice(0).reverse()) disposable.dispose();
  }
}
