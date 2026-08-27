# Jojo Extension Contract 稳定化优化方案 v2（Code-Aligned）

> 校准日期：2026-08-26  
> 代码基线：`zxt6991-source/jojo-agent@93cbdbfcde828f0f227dfe2cf9594e575dbf5f1e`  
> 前一版 Contract 文档提交：`ede0a1072c88116386076b1da2868a14728785cd`

## 1. 结论

前一版 Extension Contract 的目标正确：

```text
新增能力不能继续侵入 Runtime Kernel
```

但结合当前代码，需要比 Runtime Contract 更明显地修改。

关键修订：

1. Extension Host 不重新实现 Hook/Provider/Profile Registry；
2. 它应成为“现有 Registry 上方的 Contribution Facade”；
3. 最新 `browser-automation` 证明 Capability Package 应独立于 Extension；
4. `registerMemoryProvider`、`registerProvider` 不应现在就标 Stable；
5. 当前 `contracts/extensions.ts` 实际是 MCP/Skills/Browser Integration Settings，需要和未来 Plugin Contract 分名；
6. 第三方 TS Loader 继续后置，先让 Jojo 自己的内建能力 dogfood Contribution API。

---

## 2. 当前代码真实状态

当前 `packages/extensions`：

```text
mcp-manager.ts
mcp-oauth.ts
permission-gate.ts
skill-installer.ts
skills.ts
```

它现在本质上是：

```text
MCP + Skills Integration
```

不是完整 Plugin Host。

当前 `contracts/extensions.ts` 包含：

```text
McpServerConfig
BrowserSettings
ExtensionSettings
McpServerStatus
SkillStatus
ExtensionStatus
```

所以当前的 “Extension” 命名实际表达：

```text
Desktop integrations/settings
```

而不是：

```text
Code Extension Platform
```

---

## 3. 先解决 Extension 命名冲突

建议新增：

```text
packages/contracts/src/integrations.ts
packages/contracts/src/extension-api.ts
```

迁移：

```text
MCP / Skills / Browser Settings
        ↓
integrations.ts

未来 Plugin Contract
        ↓
extension-api.ts
```

旧：

```text
extensions.ts
```

短期只做 compatibility re-export，避免一次 breaking change。

---

## 4. Extension 与 Capability Package 分开

最新 Browser 抽离非常关键。

现在：

```text
packages/browser-automation
```

已经定义：

```text
BrowserDriver
BrowserSession
BrowserPage
BrowserHealingPort
BrowserPermissionPort
Recording / Replay
HeadlessBrowserHost
Chrome CDP Driver
```

这说明：

```text
Capability Package = 能力实现
Extension Contribution = 能力如何接入 Jojo
```

两者不是一回事。

---

## 5. Browser 不应成为 `registerBrowser()` v1

Browser 本身继续作为：

```text
first-party capability service
```

接入 Runtime：

```text
browser-automation
      ↓
Browser Tool Adapter
      ↓
Tool Registry
```

Desktop Dock：

```text
browser-automation
      ↓
Desktop Host Adapter
```

不要让 Extension API v1 直接暴露：

```text
BrowserWindow
WebContentsView
Dock UI
Chrome process
```

---

## 6. Extension Host 的新定位

前一版容易变成：

```text
Extension Host
自己维护 ToolRegistry
自己维护 HookRegistry
自己维护 ProviderRegistry
自己维护 AgentRegistry
```

v2 改为：

```text
Extension Host
=
Contribution Router + Lifecycle + Trust + Permission
```

底层 Registry 尽量复用当前代码。

---

## 7. 当前已有 HookRegistry，直接复用

当前：

```text
packages/hooks
```

已有：

```text
HookRegistry
DefaultHookRuntime
ShellHookRunner
Disposable
Typed HookHandler
Trust
InvocationStore
```

因此：

```ts
api.registerHook(...)
```

内部直接调用：

```text
HookRegistry.on(...)
```

不要再创建 `ExtensionHookRegistry`。

---

## 8. 当前已有 Provider Registry

`packages/providers` 已存在：

```text
registry.ts
ProviderRegistration
createProvider
```

未来：

```text
ProviderContribution
      ↓
ProviderRegistry Adapter
```

不要让 Extension Host 维护第二个 provider map。

---

## 9. 当前已有 AgentProfileRegistry

Orchestration 已有：

```text
AgentProfileRegistry
createBuiltinAgentProfileRegistry
```

未来：

```text
AgentProfileContribution
      ↓
AgentProfileRegistry Adapter
```

不要创建平行 Profile Registry。

---

## 10. Extension API v2

```ts
interface ExtensionAPI {
  readonly extension: ExtensionIdentity;
  readonly runtime: ExtensionRuntimeView;
  readonly storage: ExtensionStorage;

  registerTool(
    contribution: ToolContribution
  ): Disposable;

  registerHook<E extends HookEventName>(
    event: E,
    handler: HookHandler<E>,
    options?: RegisterHookOptions
  ): Disposable;

  registerContextContributor(
    contribution: ContextContributor
  ): Disposable;

  // Preview
  registerProvider(
    contribution: ProviderContribution
  ): Disposable;

  // Preview
  registerAgentProfile(
    contribution: AgentProfileContribution
  ): Disposable;

  // Preview
  registerWorkflowStep(
    contribution: WorkflowStepContribution
  ): Disposable;

  // Preview
  registerMemoryAdapter(
    contribution: MemoryAdapterContribution
  ): Disposable;
}
```

---

## 11. Extension API v1 的稳定等级需要修改

### Stable v1 候选

```text
Extension Identity
Contribution Owner
Disposable
Lifecycle
Tool Contribution
Hook Contribution
Context Contribution
Extension Storage
Capability declaration
Permission declaration
Read-only Runtime View
```

### Preview

```text
Provider Contribution
Agent Profile Contribution
Workflow Step ABI
Memory Provider/Adapter
```

### Deferred

```text
UI Contribution
TypeScript Loader ABI
Sandbox ABI
Marketplace
Remote package install
```

---

## 12. 为什么 Tool 可以先稳定

当前已有：

```text
Tool
ToolDefinition
ToolContext
ToolResult
replay
repeatPolicy
polling
```

MCP、Browser、Node Tools 都能最终落到同一个 Tool Contract。

Extension Host 只补：

```text
owner
namespace
permission grant
source
```

推荐：

```ts
type ToolContribution = {
  id: string;
  tool: Tool;
};
```

不要再创建另一套 `ExtensionTool`。

---

## 13. Tool Namespace

内建保持：

```text
read_file
terminal
browser
```

第三方：

```text
<extension-id>:<tool-name>
```

例如：

```text
com.acme.jira:create_issue
```

避免静默覆盖。

---

## 14. 为什么 Hook 可以先稳定

现在已经有完整：

```text
7 lifecycle events
HookRuntime
HookRegistry
Typed Handler
canApprove
onError
async
Invocation Store
Project Trust
```

所以 Extension Host 应直接复用。

Extension 的 `canApprove` 不能仅靠 Manifest 声明获得，必须经过 Host grant。

---

## 15. Context Contributor 是真正值得新增的 v1 Contract

```ts
interface ContextContributor {
  id: string;
  priority?: number;

  contribute(
    request: ContextContributionRequest
  ): Promise<ContextContribution>;
}
```

适合：

```text
Skill
Memory Recall
Project Instructions
Enterprise Policy
Calendar
CRM
Issue Tracker
Browser Current State
```

Extension 不能直接修改内部 `Message[]`。

---

## 16. Context Block

```ts
type ContextBlock = {
  id: string;

  kind:
    | 'instruction'
    | 'memory'
    | 'resource'
    | 'environment';

  content: string;
  priority: number;
  source: string;

  cachePolicy?:
    | 'stable'
    | 'session'
    | 'turn';
};
```

Context Builder 统一做：

```text
budget
priority
dedupe
cache
trace
```

---

## 17. MCP 接入方式

当前 `McpManager` 继续独立。

目标：

```text
MCP Server
   ↓
McpManager
   ↓
Tool Adapter
   ↓
Tool Registry
```

未来 MCP Resource：

```text
MCP Resource
   ↓
Context Contributor
```

Runtime 永远不需要知道工具来自 MCP。

---

## 18. Skill 接入方式

Skill 仍不是 Code Extension。

建议：

```text
Skill
  ├─ Context Contribution
  └─ Resource/Install Tools
```

这样保持 Skill 的低风险、文本资源属性。

---

## 19. Provider Contribution 先 Preview

当前 Provider 主要仍是：

```text
OpenAICompatibleProvider
OpenAICompatibleEmbeddingProvider
```

未来还要做：

```text
Anthropic
Gemini
OpenAI native
reasoning
prompt cache
structured output
```

因此先稳定：

```text
ModelProvider
ProviderCapabilities
```

再冻结：

```text
registerProvider()
```

Provider Contribution 只应该是 Factory：

```ts
type ProviderContribution = {
  id: string;
  capabilities: ProviderCapabilities;
  create(config: JsonValue): Promise<ModelProvider>;
};
```

---

## 20. Memory Contribution 不应现在 Stable

当前 Memory 已包含：

```text
Markdown truth
FTS
Semantic
Embedding
Candidate Governance
Snapshot
Handoff
Compaction
SubAgent Binding
Workflow Binding
```

此时开放完整：

```text
registerMemoryProvider
```

会把 Memory 内部模型提前锁死。

第一阶段只开放：

```text
Context Contributor
Memory Tool
```

完整 Memory Adapter 等 `MemoryRuntime` 稳定后再升级。

---

## 21. Workflow Step 继续 Preview

Extension 只能注册：

```text
Step Executor
```

不能接管：

```text
DAG
retry
timeout
budget
resource group
journal
resume
```

这些继续由 `packages/orchestration` 负责。

---

## 22. Agent Profile 继续 Preview

当前 Profile 已经与：

```text
ToolPolicy
ReadOnly
Worktree Isolation
Memory
Model
```

关联。

所以先复用现有 `AgentProfileRegistry`，不要过早冻结第三方 Profile ABI。

---

## 23. Permission 不建立第二套 Engine

当前已经有：

```text
PermissionGate
Hook approve/block
MCP Permission
Browser Permission
Desktop Approval
```

Extension Manifest Permission 应只是：

```text
声明
```

最终翻译到：

```text
现有 Permission / Hard Safety
```

结构：

```text
Manifest Permission
       ↓
Host Grant
       ↓
Runtime PermissionGate
       ↓
Hard Safety
```

Extension 永远不能绕过最后一层。

---

## 24. Capability 与 Permission 保持分离

Capability：

```text
tool
hook
context
provider
agent_profile
workflow_step
memory
```

Permission：

```text
filesystem.read
filesystem.write
process.execute
network
credentials.read
browser.control
memory.read
memory.write
runtime.observe
```

---

## 25. Built-in Contribution 不强制 Manifest

前一版几乎默认所有 Extension 都需要 Manifest。

v2 改为：

### Built-in

只需要：

```ts
type ContributionOwner = {
  id: string;
  version: string;
  source: 'builtin';
};
```

### External Code Extension

才需要：

```text
Manifest
Fingerprint
Trust
Permission Grant
Loader
```

这样可以先 dogfood API，再做 Loader。

---

## 26. External Manifest 继续保留，但标 Preview

```ts
type ExtensionManifest = {
  id: string;
  name: string;
  version: string;
  apiVersion: string;

  capabilities: ExtensionCapability[];
  permissions?: ExtensionPermissionRequest[];

  compatibility?: {
    jojo?: string;
    platforms?: string[];
  };
};
```

---

## 27. Extension Runtime View 只能读

```ts
interface ExtensionRuntimeView {
  getSessionInfo(...): Promise<Readonly<SessionInfo> | undefined>;
  getLaneInfo(...): Promise<Readonly<LaneInfo> | undefined>;
  getRunSnapshot(...): Promise<Readonly<RunSnapshot> | undefined>;
  subscribe(...): Disposable;
}
```

禁止：

```text
getRuntimeStore
setOperationState
dispatchReducer
getSQLite
getElectronWindow
modifyMessagesDirectly
```

---

## 28. Extension Storage

继续保留：

```ts
interface ExtensionStorage {
  get(key: string): Promise<JsonValue | undefined>;
  set(key: string, value: JsonValue): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}
```

namespace：

```text
extension/<extensionId>/*
```

Secret 走独立 Credential Store。

---

## 29. Lifecycle

```text
discover
validate
trust
load
activate
register
running
drain
deactivate
dispose
```

Built-in 可以从：

```text
activate/register
```

开始。

---

## 30. Run 开始时冻结 Contribution Snapshot

建议 Operation Meta 记录：

```text
toolCatalogVersion
hookRegistryVersion
providerRegistrationVersion
agentProfileRevision
extension set/version
```

这样 Hot Reload 或配置变化不会改变正在运行的 Operation。

---

## 31. 最新 Browser 代码还暴露一个共同问题

`browser-automation/src/index.ts` 现在也大量：

```text
export *
```

所以 Contract Hygiene 必须成为整个 Jojo 的统一规则：

```text
Curated root export
+
subpath export
+
internal 不公开
```

不是只治理 `agent-runtime`。

---

## 32. Extension Host 推荐结构

```text
packages/extensions/src/
├── api/
│   ├── identity.ts
│   ├── contributions.ts
│   ├── capabilities.ts
│   └── extension-api.ts
│
├── host/
│   ├── extension-host.ts
│   ├── lifecycle.ts
│   └── contribution-router.ts
│
├── adapters/
│   ├── hook-registry-adapter.ts
│   ├── provider-registry-adapter.ts
│   ├── agent-profile-registry-adapter.ts
│   ├── mcp-adapter.ts
│   └── skill-adapter.ts
│
├── trust/
├── storage/
├── loader/
└── testing/
```

注意：

```text
ContributionRouter
```

统一 Owner/Lifecycle/Permission。

但不要强行把所有 contribution 存成：

```ts
Map<string, any>
```

底层仍由不同 Registry 管理。

---

## 33. 推荐 Dogfood 顺序

### E0

```text
Extension Identity
Contribution Owner
Disposable
Lifecycle
```

### E1

```text
HookRegistry Adapter
```

### E2

```text
Tool Registry
MCP Tool Adapter
```

### E3

```text
Context Registry
Skill Adapter
```

### E4

```text
Browser Tool Adapter
```

### E5

```text
AgentProfileRegistry Adapter
```

### E6

```text
ProviderRegistry Adapter
```

### E7

```text
WorkflowStep Preview
Memory Preview
```

### E8

```text
External local Code Loader
```

### E9

```text
Extension API v1 Freeze
```

---

## 34. 最终架构

```text
                         Extension Host
                               │
                    lifecycle/trust/security
                               │
       ┌───────────────┬───────┼────────────────┐
       ▼               ▼       ▼                ▼
 Tool Adapter      Hook Adapter Context Adapter Provider Adapter
       │               │       │                │
       ▼               ▼       ▼                ▼
 Tool Registry     HookRegistry ContextRegistry ProviderRegistry

       AgentProfile Adapter       WorkflowStep Adapter
               │                           │
               ▼                           ▼
      AgentProfileRegistry            Workflow Engine
```

底层能力包：

```text
MCP
Skills
Browser Automation
Memory
Providers
Node Tools
```

通过 Adapter 接入。

---

## 35. 最终判断

Extension Contract 前一版最需要修正的一句话是：

原先容易理解为：

> “Extension Host 拥有 Jojo 的所有扩展能力。”

v2 应改成：

> **“Capability Package 拥有能力，Extension Host 只负责让能力以统一、受控、可版本化的方式接入 Jojo。”**

所以最终原则是：

```text
能力实现 -> Capability Package
能力接入 -> Extension Contribution
长期执行 -> Runtime Contract
多 Agent 调度 -> Orchestration
```

这比把所有能力重新塞回一个“大 extensions 包”更适合 Jojo 当前代码。
