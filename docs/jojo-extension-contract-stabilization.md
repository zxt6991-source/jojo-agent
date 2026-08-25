# Jojo Extension Contract 稳定化优化方案

> 文档状态：Proposed Final Contract  
> 日期：2026-08-26  
> 目标仓库：`zxt6991-source/jojo-agent`  
> 适用范围：`packages/extensions`、`packages/hooks`、`packages/providers`、`packages/orchestration`、`packages/agent-runtime`、MCP、Skills、Memory、Browser 以及未来第三方插件  
> 核心目标：**建立一个统一但不过度耦合的 Extension Contract，使 Tool / Hook / Context / Provider / Memory / Agent Profile / Workflow Step 可以通过稳定 API 扩展 Jojo，而不直接侵入 Runtime Kernel。**

---

## 1. 结论

Jojo 当前已经有多个“扩展机制”：

```text
MCP
Skills
Hooks
Agent Profiles
Saved Workflows
Provider Config
Memory Runtime
Browser
```

但这些能力目前属于：

```text
多个独立扩展点
```

还不是：

```text
统一 Extension Platform
```

当前 `packages/extensions` 主要承担：

```text
MCP
Skills
MCP OAuth
MCP Permission Gate
Skill installer
```

而 Hooks 已经拆到：

```text
packages/hooks
```

这是正确的。

下一阶段**不要把所有实现重新搬进 `packages/extensions`**。

正确方向是：

```text
packages/extensions
=
Extension Contract
+
Extension Registry
+
Extension Lifecycle
+
Loader / Trust
```

具体能力实现继续独立：

```text
hooks
providers
memory
browser
mcp
skills
orchestration
```

最终：

```text
                     Extension Host
                           │
         ┌─────────────────┼──────────────────┐
         ▼                 ▼                  ▼
       Tool             Hook             Context
         │                 │                  │
         ├──────────┬──────┼───────┬──────────┤
         ▼          ▼              ▼          ▼
      Provider    Memory        Agent       Workflow
                               Profile       Step
```

---

# 2. 为什么现在必须冻结 Extension Contract

如果继续按能力分别扩：

```text
Runner 加一个参数
Worker 加一个 Manager
Settings 加一个配置
Contracts 加一个 IPC
```

未来会逐渐形成：

```text
Runtime
├── hooks special case
├── memory special case
├── mcp special case
├── browser special case
├── skill special case
├── enterprise special case
├── provider special case
└── ...
```

这会重新把已经拆开的架构揉回 Harness。

Extension Contract 的作用不是“做插件市场”。

第一目标是：

> **让 Jojo 自己的内建能力也通过统一扩展接口装配。**

只有内建能力先吃自己的 Extension API：

```text
dogfooding
```

Contract 才可信。

---

# 3. Extension 与 Hook 的关系

必须明确：

```text
Extension
≠
Hook
```

Hook 是 Extension 可以注册的一种能力。

```text
Extension
├── Tool
├── Hook
├── Context Contributor
├── Provider
├── Memory Backend
├── Agent Profile
├── Workflow Step
└── UI Contribution（后置）
```

`packages/hooks`：

```text
负责 Hook Engine
```

`packages/extensions`：

```text
负责谁注册 Hook
+
Extension 生命周期
+
权限 / Trust / Capability
```

---

# 4. Extension 与 MCP 的关系

同样：

```text
Extension
≠
MCP
```

MCP 是远程/外部 Tool Provider。

可以做：

```text
MCP Adapter
    ↓
Tool Contribution
```

因此未来：

```text
MCP Tool
Local Tool
Built-in Tool
Extension Tool
```

全部最终进入：

```text
Tool Registry
```

Runtime 不需要知道工具来自哪里。

---

# 5. Extension 与 Skill 的关系

Skill 是：

```text
Prompt / Resource / Instruction Package
```

不是任意代码扩展。

因此：

```text
Skill
  ↓
Context / Resource Contribution
```

不要让 Skill 自动获得：

```text
filesystem write
process
network
credentials
```

Skill 与 Code Extension 必须保持不同安全等级。

---

# 6. Extension Contract 的核心原则

必须冻结以下原则：

1. **Capability Based**
2. **Explicit Permission**
3. **Runtime Independent**
4. **Transport Independent**
5. **No Direct State Mutation**
6. **Typed Registration**
7. **Versioned Manifest**
8. **Deterministic Unload**
9. **Trust On First Use**
10. **Durable Side Effects Respect Runtime Recovery**

---

# 7. Extension Package 定位

推荐：

```text
packages/extensions/
├── contract/
├── host/
├── registry/
├── loader/
├── trust/
├── capability/
├── testing/
└── adapters/
```

而不是：

```text
packages/extensions/
├── all-mcp-code
├── all-hook-code
├── all-provider-code
├── all-memory-code
└── all-browser-code
```

---

# 8. Extension Manifest

每个 Code Extension 必须有稳定 Manifest。

```ts
export type ExtensionManifest = {
  id: string;
  name: string;
  version: string;

  apiVersion: string;

  description?: string;

  capabilities: ExtensionCapability[];

  permissions?: ExtensionPermissionRequest[];

  entry?: string;

  scope:
    | 'user'
    | 'project';

  compatibility?: {
    jojo?: string;
    platforms?: string[];
  };
};
```

示例：

```json
{
  "id": "com.example.security-review",
  "name": "Security Review",
  "version": "1.2.0",
  "apiVersion": "1",
  "capabilities": [
    "tool",
    "hook",
    "agent_profile"
  ],
  "permissions": [
    {
      "capability": "process.execute",
      "reason": "Run local security scanner"
    }
  ],
  "scope": "project"
}
```

---

# 9. Extension Identity

`id` 必须：

```text
稳定
全局唯一
不能随 display name 改
```

建议：

```text
reverse-domain
```

例如：

```text
dev.jojo.browser
dev.jojo.memory
com.company.review
```

所有持久化 Extension 状态使用：

```text
extensionId
```

不能使用文件路径作为 identity。

---

# 10. Extension API Version

必须独立于 Jojo package version。

```ts
export const EXTENSION_API_VERSION = '1';
```

Manifest：

```json
{
  "apiVersion": "1"
}
```

这样：

```text
Jojo 0.5
Jojo 0.6
Jojo 1.0
```

可以继续兼容：

```text
Extension API v1
```

---

# 11. Extension Factory Contract

推荐：

```ts
export type JojoExtensionFactory = (
  api: ExtensionAPI
) =>
  | void
  | ExtensionInstance
  | Promise<void | ExtensionInstance>;
```

```ts
export interface ExtensionInstance {
  deactivate?(): Promise<void> | void;
}
```

### 原则

Extension import 时：

```text
不得自动启动长期副作用
```

长期资源必须在：

```text
activate
session lifecycle
specific command/tool
```

里显式创建。

---

# 12. ExtensionAPI

第一版建议冻结：

```ts
export interface ExtensionAPI {
  readonly extension: ExtensionIdentity;

  readonly runtime: ExtensionRuntimeView;

  readonly storage: ExtensionStorage;

  registerTool(
    contribution: ToolContribution
  ): Disposable;

  registerHook<E extends StableHookEvent>(
    event: E,
    handler: ExtensionHookHandler<E>
  ): Disposable;

  registerContextContributor(
    contribution: ContextContributionProvider
  ): Disposable;

  registerProvider(
    contribution: ProviderContribution
  ): Disposable;

  registerMemoryProvider(
    contribution: MemoryProviderContribution
  ): Disposable;

  registerAgentProfile(
    contribution: AgentProfileContribution
  ): Disposable;

  registerWorkflowStep(
    contribution: WorkflowStepContribution
  ): Disposable;

  onDispose(
    callback: () => void | Promise<void>
  ): Disposable;
}
```

---

# 13. 第一版不应该开放的 API

不要开放：

```ts
api.getRuntimeStore()
api.setOperationState()
api.dispatchReducer()
api.getSQLite()
api.getElectronWindow()
api.getWorkerProcess()
api.modifyMessagesDirectly()
```

否则 Extension API 会穿透 Runtime Contract。

---

# 14. Extension Runtime View

Extension 可能需要观察 Runtime，但只能获得只读 View。

```ts
export interface ExtensionRuntimeView {
  getSessionInfo(
    sessionId: string
  ): Promise<Readonly<SessionInfo> | undefined>;

  getLaneInfo(
    sessionId: string,
    laneId: string
  ): Promise<Readonly<LaneInfo> | undefined>;

  getRunSnapshot(
    runId: string
  ): Promise<Readonly<RunSnapshot> | undefined>;

  subscribe(
    listener: RuntimeEventListener
  ): Disposable;
}
```

没有 mutation API。

---

# 15. Capability Model

每个 Extension 明确声明能力。

建议首版：

```ts
export type ExtensionCapability =
  | 'tool'
  | 'hook'
  | 'context'
  | 'provider'
  | 'memory'
  | 'agent_profile'
  | 'workflow_step'
  | 'ui';
```

Host 只暴露声明过的 registration API。

例如：

```text
Manifest 没有 provider
        ↓
registerProvider()
        ↓
拒绝
```

---

# 16. Permission 与 Capability 必须区分

Capability：

```text
Extension 能扩展 Jojo 的哪一类接口
```

Permission：

```text
Extension 实际能访问哪些外部资源
```

例如：

```text
capability: tool

permission:
- filesystem.read
- process.execute
```

这两个概念不能混在一起。

---

# 17. Permission Contract

建议：

```ts
export type ExtensionPermission =
  | 'filesystem.read'
  | 'filesystem.write'
  | 'process.execute'
  | 'network'
  | 'credentials.read'
  | 'browser.control'
  | 'runtime.observe'
  | 'runtime.context'
  | 'memory.read'
  | 'memory.write';
```

未来可增加 scope：

```ts
{
  permission: 'network',
  scope: ['api.example.com']
}
```

---

# 18. Hard Safety Boundary

无论 Extension 是否 trusted：

```text
Extension
  ↓
不能覆盖 Hard Deny
```

优先级建议：

```text
Runtime Hard Deny
      >
Extension Hook Block
      >
Permission Deny
      >
Trusted Auto-Approval
      >
User Approval
      >
Allow
```

Extension 的：

```text
approve
```

最多只能：

```text
消除 ask
```

不能：

```text
deny -> allow
```

---

# 19. Tool Contribution Contract

```ts
export type ToolContribution = {
  descriptor: {
    name: string;
    description: string;
    inputSchema: JsonSchema;

    replay:
      | 'safe'
      | 'never';

    risk:
      | 'read'
      | 'write'
      | 'external_side_effect';
  };

  execute(
    input: JsonValue,
    context: ExtensionToolContext
  ): Promise<ToolExecutionResult>;
};
```

Tool 一旦注册：

```text
Extension Tool
      ↓
Tool Registry
      ↓
Runtime Tool Port
```

不走特殊路径。

---

# 20. Tool Name Namespace

避免冲突。

建议：

内建：

```text
read_file
terminal
web_search
```

第三方：

```text
<extension-id>:<tool-name>
```

显示层可以映射友好名。

例如：

```text
com.acme.jira:create_issue
```

---

# 21. Tool Input Validation

无论来源：

```text
Built-in
MCP
Extension
```

都必须：

```text
Schema Validate
     ↓
Hook
     ↓
Permission
     ↓
Execute
```

如果 Hook 将来允许 patch input：

```text
Hook Patch
   ↓
重新 Schema Validate
   ↓
重新 Permission Preview
```

---

# 22. Hook Contribution Contract

稳定 Hook Event 首版保持少而稳定：

```text
SessionStart
UserPromptSubmit
PreToolUse
PostToolUse
Stop
SubagentStop
PreCompact
```

Extension 注册：

```ts
api.registerHook('PreToolUse', async (event, ctx) => {
  return {
    decision: 'block',
    reason: '...'
  };
});
```

### 重要

不要把所有内部 Runtime Event 都提升成 Hook。

例如：

```text
operation.reducer.applied
register.updated
effect.intent.committed
```

这些属于 Runtime internal telemetry。

---

# 23. Hook Handler Contract

```ts
export type HookDecision =
  | {
      action: 'neutral';
    }
  | {
      action: 'block';
      reason: string;
    }
  | {
      action: 'approve';
      reason?: string;
    };
```

V1 不支持：

```text
任意修改 Tool Input
任意替换 Messages
任意修改 Operation State
```

---

# 24. Context Contributor

这是 Jojo 从 Coding Agent 变成 General Agent 很重要的扩展点。

```ts
export interface ContextContributionProvider {
  id: string;
  priority?: number;

  contribute(
    request: ContextContributionRequest,
    context: ContextContributionContext
  ): Promise<ContextContribution>;
}
```

来源可以：

```text
Skill
Memory
Project Rules
Enterprise Policy
Issue Tracker
Calendar
CRM
User Profile
```

---

# 25. Context Contribution 必须结构化

不要只返回任意字符串。

推荐：

```ts
export type ContextContribution = {
  blocks: ContextBlock[];

  cachePolicy?:
    | 'stable'
    | 'session'
    | 'turn';

  estimatedTokens?: number;
};
```

ContextBlock：

```ts
type ContextBlock = {
  id: string;

  role:
    | 'system'
    | 'developer'
    | 'context';

  content: string;

  priority: number;

  source: string;
};
```

这能让 Context Builder 统一：

```text
budget
priority
cache
dedupe
trace
```

---

# 26. Provider Contribution

Extension 应允许第三方 Provider Adapter。

```ts
export type ProviderContribution = {
  descriptor: ProviderDescriptor;

  create(
    config: ProviderConfig
  ): Promise<ModelProvider>;
};
```

Provider 只需要满足 Runtime Provider Port。

这样：

```text
OpenAI
Anthropic
Gemini
Ollama
Company Gateway
Private Model
```

不需要修改 Runtime。

---

# 27. Provider Secret Contract

Extension 不得直接：

```text
读取整个 settings.json
```

应该：

```ts
const token = await ctx.credentials.get(
  'api-key'
);
```

Credential Store 必须：

```text
namespace by extension id
```

例如：

```text
extension/com.acme.jira/api-token
```

---

# 28. Memory Provider Contribution

Memory 不应等同于单个实现。

建议 Extension API：

```ts
export type MemoryProviderContribution = {
  id: string;
  description: string;

  create(
    context: MemoryProviderCreateContext
  ): Promise<MemoryPort>;
};
```

内建 Jojo Memory：

```text
Markdown Truth
FTS
Semantic
Hybrid
Candidate
```

可以作为：

```text
builtin memory provider
```

而不是 Runtime special case。

---

# 29. Memory Extension Safety

Memory Provider 默认不能：

```text
看到完整 filesystem
看到所有 credentials
自动上传所有 session
```

远程 Embedding / Memory 服务必须明确声明：

```text
network
memory.read
```

并由 Host 显示数据边界。

---

# 30. Agent Profile Contribution

当前：

```text
explore
general
code-review
synthesize
```

未来统一：

```ts
export type AgentProfileContribution = {
  id: string;
  description: string;

  readOnly?: boolean;

  toolPolicy?: ToolPolicy;

  modelPolicy?: ModelPolicy;

  systemPrompt?: string;

  memoryPolicy?: MemoryBindingPolicy;

  isolation?: IsolationPolicy;
};
```

这样用户/项目 Agent Profile 不需要由 Orchestration 写特殊 loader。

---

# 31. Agent Profile 与 Agent Runtime 的边界

Profile：

```text
配置
```

不是：

```text
自己的 Agent Loop 实现
```

执行仍然：

```text
Agent Profile
    ↓
Runtime Lane
    ↓
Runtime Run
```

---

# 32. Workflow Step Contribution

Jojo 应继续以 Declarative DAG 为主。

Extension 可以注册新 Step Type：

```ts
export type WorkflowStepContribution = {
  type: string;

  schema: JsonSchema;

  execute(
    input: JsonValue,
    context: WorkflowStepContext
  ): Promise<WorkflowStepResult>;
};
```

例如：

```text
http
human
database
ticket
slack
deploy
```

---

# 33. Workflow Step 权限

Workflow Step 不绕过 Permission。

正确链：

```text
Workflow Engine
     ↓
Extension Workflow Step
     ↓
Capability / Permission
     ↓
Effect
```

对于真正需要 Agent 的 Step：

```text
Workflow Step
     ↓
Runtime Lane.run()
```

---

# 34. 不建议首版开放 Dynamic Runtime Replacement

不要允许 Extension：

```text
replaceReducer()
replaceInterpreter()
replaceRuntimeStore()
replacePermissionEngine()
replaceRecoveryPolicy()
```

这些属于 Kernel，不属于 Extension Contract v1。

---

# 35. Storage Contract

每个 Extension 提供 namespace storage：

```ts
export interface ExtensionStorage {
  get<T extends JsonValue>(
    key: string
  ): Promise<T | undefined>;

  set(
    key: string,
    value: JsonValue
  ): Promise<void>;

  delete(
    key: string
  ): Promise<void>;

  list(
    prefix?: string
  ): Promise<string[]>;
}
```

真实持久化：

```text
extension/<extensionId>/<key>
```

Extension 不知道：

```text
SQLite
JSON
filesystem path
```

---

# 36. Extension State Version

Extension 自己负责 state version：

```json
{
  "_schema": 3
}
```

建议 API 支持：

```ts
api.storage.migrate(...)
```

首版也可让 Extension 自己实现。

---

# 37. Extension Lifecycle

稳定生命周期：

```text
discover
   ↓
validate manifest
   ↓
trust
   ↓
load
   ↓
activate
   ↓
register contributions
   ↓
running
   ↓
deactivate
   ↓
dispose
```

Project Extension 内容变化：

```text
fingerprint changed
      ↓
trust invalid
      ↓
disable
      ↓
request re-trust
```

---

# 38. User Extension 与 Project Extension

建议：

```text
~/.jojo/extensions/
.jojo/extensions/
```

规则：

```text
user extension
    ↓
always user-owned trust

project extension
    ↓
TOFU + fingerprint
```

项目 Extension 不允许静默执行。

---

# 39. Project Extension Trust

Trust 记录：

```ts
type ExtensionTrustRecord = {
  extensionId: string;
  projectId: string;

  fingerprint: string;

  grantedCapabilities: ExtensionCapability[];

  grantedPermissions: ExtensionPermission[];

  trustedAt: string;
};
```

Extension manifest 或代码变化：

```text
fingerprint changed
```

需要重新确认危险权限。

---

# 40. Loader

建议首版 Loader：

```text
Built-in Extension
Local User Extension
Local Project Extension
```

后置：

```text
npm package
git package
marketplace
remote install
```

不要第一阶段做供应链平台。

---

# 41. TypeScript Loader

可以借鉴 Pi：

```text
TypeScript Extension
```

但 Jojo 应更保守。

建议：

```text
Phase 1:
compiled JS / packaged internal extension

Phase 2:
trusted TS via controlled loader

Phase 3:
package install
```

原因：

```text
直接加载 TS
=
任意代码执行
```

安全/依赖/供应链必须成熟后再默认开放。

---

# 42. Sandbox

长期 Code Extension 建议支持：

```text
in-process trusted
worker-isolated
external process
```

V1 可以只有：

```text
trusted in-process
```

但 Manifest 提前预留：

```ts
execution:
  | 'in_process'
  | 'worker'
  | 'external';
```

---

# 43. Extension Host 不应该运行在 Renderer

必须运行：

```text
Utility Process / Runtime Process
```

Renderer 只：

```text
显示 extension status
配置
trust
permission prompt
```

否则会破坏 Electron sandbox。

---

# 44. UI Contribution

UI Plugin 首版后置。

如果未来支持：

```text
Settings Page
Tool Renderer
Workflow Card
Status Bar
Panel
```

必须用声明式 contribution。

不要让 Extension：

```ts
import ReactDOM
document.body.appendChild(...)
```

建议：

```ts
registerView({
  slot: 'settings',
  schema: ...
})
```

或者独立 sandbox iframe/webview。

---

# 45. Extension Event 与 Runtime Event

需要两个 Event System：

```text
Runtime Event
=
事实通知

Hook Event
=
可参与决策的生命周期点
```

不要混为一个。

例如：

```text
ToolStarted
```

是 Runtime Event。

```text
PreToolUse
```

是 Hook Event。

---

# 46. Event Reliability

Extension 对 Runtime Event 的监听：

```text
best effort observation
```

不能靠它实现关键 durable side effect。

关键 side effect：

```text
必须使用 Hook durable invocation
或 Workflow Step
```

否则 Crash 后可能丢失。

---

# 47. Durable Extension Side Effect

例如：

```text
Stop
 ↓
发送 Slack 通知
```

如果要求 crash-safe：

```text
TX extension intent
      ↓
send Slack
      ↓
TX extension settlement
```

并记录：

```text
invocationId
```

Extension 应使用：

```text
idempotency key
```

---

# 48. Extension Invocation Identity

统一：

```ts
type ExtensionInvocation = {
  invocationId: string;

  extensionId: string;

  contributionId: string;

  sessionId?: string;
  laneId?: string;
  runId?: string;

  eventId?: string;
};
```

远程系统可使用：

```text
invocationId
```

作为幂等 key。

---

# 49. Error Isolation

Extension Error 不应该默认导致 Runtime 崩溃。

按 Contribution 类型定义：

## Tool

```text
tool failed
```

返回 ToolResult。

## Context

```text
fail-open
+
warning
```

除非声明：

```text
required
```

## Hook

按 Event Policy：

```text
PreToolUse
  可 fail-closed for enterprise policy

普通 User Hook
  默认 fail-open
```

## Provider

```text
provider error
```

进入 Runtime provider failure。

## Memory

```text
fallback/no-memory
```

由 Runtime Policy 决定。

---

# 50. Contribution Priority

需要确定合并顺序。

建议：

```text
Runtime hard policy
    ↓
Built-in
    ↓
User
    ↓
Project
```

但对不同类型含义不同。

### Hook

```text
全部执行
```

block：

```text
first block wins
```

### Context

按：

```text
priority
```

排序。

### Tool

同名禁止覆盖。

### Provider

同 id 禁止覆盖，除非显式 disable + replace。

---

# 51. Contribution ID

每项贡献必须稳定 id。

例如：

```text
extension:
  com.acme.devops

tool:
  deploy

full contribution id:
  com.acme.devops/tool/deploy
```

用于：

```text
日志
权限
禁用
Usage
Trace
Resume
```

---

# 52. Hot Reload

Hot reload 可以做，但必须满足：

```text
没有 active invocation
或
旧实例 drain
```

流程：

```text
mark draining
  ↓
不接受新 invocation
  ↓
等待 active invocation
  ↓
deactivate
  ↓
load new
```

不要：

```text
直接删除正在运行 Extension instance
```

---

# 53. Runtime Run 对 Extension Version 的绑定

一次 Run 开始时应 snapshot：

```text
extension set
+
extension versions
+
contribution versions
```

Run 中途热加载新 Extension：

```text
默认不改变正在运行的 Run
```

否则：

```text
prompt cache
tool list
permission
recovery
```

都会不稳定。

---

# 54. Tool Catalog Snapshot

Run 开始时：

```text
Tool Catalog Version
```

持久化到 Operation Meta。

动态工具变化：

```text
必须形成显式 Tool Catalog Change
```

不能静默变化。

---

# 55. Provider Snapshot

同理：

```text
provider id
adapter version
model
capabilities
```

在 Model effect intent 前必须确定。

Resume 时如果 Provider 不存在：

```text
suspended: provider_unavailable
```

而不是自动换模型。

---

# 56. Extension Security Summary

分三层：

```text
Layer 1
Manifest Capability

Layer 2
Host Permission

Layer 3
Runtime Hard Safety
```

任何 Extension 不能绕过 Layer 3。

---

# 57. Extension Testing API

提供：

```text
@desktop-agent/extensions/testing
```

包括：

```ts
createTestExtensionHost()
createFakeRuntimeView()
createFakePermissionBroker()
activateExtension()
collectContributions()
invokeHook()
invokeTool()
```

---

# 58. Extension Conformance Suite

每个 Extension API v1 implementation 必须测试：

```text
manifest validation
duplicate id
capability enforcement
permission enforcement
trust invalidation
activate/deactivate
disposable cleanup
tool registration
tool schema validation
hook block
hook neutral
context ordering
provider registration
memory registration
agent profile registration
workflow step registration
storage namespace
error isolation
hot reload drain
```

---

# 59. Built-in Extension Dogfooding

长期建议将部分内建能力按 Extension Host 注册。

优先顺序：

## 第一批

```text
MCP
Skills
Hooks adapter
```

## 第二批

```text
Browser tool provider
Memory context contributor
```

## 第三批

```text
Provider adapters
Agent Profiles
Workflow custom steps
```

不是要求全部移出原 package。

而是：

```text
原 package
    ↓
实现 Contribution Adapter
    ↓
Extension Host
```

---

# 60. 当前 `packages/extensions` 优化建议

建议从：

```text
extensions/
├── mcp-manager.ts
├── mcp-oauth.ts
├── permission-gate.ts
├── skills.ts
└── ...
```

演进：

```text
extensions/
├── src/
│   ├── contract/
│   ├── host/
│   ├── registry/
│   ├── loader/
│   ├── trust/
│   ├── storage/
│   ├── testing/
│   │
│   └── adapters/
│       ├── mcp/
│       └── skills/
```

现有 MCP / Skills 实现可以先不物理搬目录。

关键是：

```text
先建立 Contract
再逐步 adapter 化
```

---

# 61. `packages/hooks` 保持独立

不要把：

```text
engine.ts
shell-runner.ts
trust.ts
config-loader.ts
invocation-store.ts
```

全部搬回 extensions。

正确：

```text
extensions
    ↓
register hook

hooks
    ↓
execute hook
```

---

# 62. `packages/providers` 保持独立

```text
Provider Adapter implementation
```

继续放：

```text
packages/providers
```

Extension Host 只负责：

```text
ProviderContribution registration
```

---

# 63. `packages/orchestration` 保持独立

```text
Workflow Engine
SubAgent
Scheduler
Resource
Worktree
```

继续独立。

Extension 只能：

```text
registerAgentProfile
registerWorkflowStep
```

不能拥有 Orchestration Kernel。

---

# 64. Public Export

推荐：

```ts
// @desktop-agent/extensions

export type {
  ExtensionManifest,
  ExtensionAPI,
  ExtensionInstance,
  ExtensionCapability,
  ExtensionPermission,
  ToolContribution,
  ContextContributionProvider,
  ProviderContribution,
  MemoryProviderContribution,
  AgentProfileContribution,
  WorkflowStepContribution
};

export {
  createExtensionHost
};
```

不要导出：

```text
McpManager internals
Hook engine internals
trust database internals
loader cache
worker handles
```

---

# 65. API Compatibility Rule

## Patch

可以：

```text
新增 optional context field
新增 helper
修 bug
```

## Minor

可以：

```text
新增 registerX()
新增 capability
新增 optional permission
```

## Major

才允许：

```text
删除 registration API
修改 permission semantic
修改 trust model
修改 contribution lifecycle
```

---

# 66. Extension Capability Detection

Host：

```ts
const caps = api.getHostCapabilities();
```

例如：

```ts
{
  browser: true,
  desktopUi: true,
  durableHooks: true,
  semanticMemory: true
}
```

Extension 应：

```text
feature detect
```

不要通过 Jojo version 字符串猜。

---

# 67. Extension Config Contract

每个 Extension 配置：

```ts
export interface ExtensionConfigStore {
  get(): Promise<JsonValue>;
  update(next: JsonValue): Promise<void>;
}
```

Host 可根据 Manifest 提供 JSON Schema。

UI 自动生成基础设置页面。

后续再支持自定义 UI。

---

# 68. Secret Config

Manifest Schema 应支持：

```json
{
  "type": "string",
  "x-jojo-secret": true
}
```

Secret：

```text
OS credential store
```

而不是普通 extension config。

---

# 69. Observability

每个 Extension invocation 应产生：

```text
extension.invocation.started
extension.invocation.completed
extension.invocation.failed
```

包含：

```text
extension id
contribution id
duration
run id
usage?
error code
```

但不要默认记录 Secret/Input 全文。

---

# 70. Extension Disable

必须支持：

```text
global disable
project disable
single contribution disable
```

例如：

```text
Extension loaded
但禁用某 Tool
```

状态应可被 Settings UI 查看。

---

# 71. Extension Conflict

同一 Contribution ID：

```text
禁止 silently overwrite
```

策略：

```text
error + disable later registration
```

不要：

```text
last wins
```

否则加载顺序会变成隐式行为。

---

# 72. Load Order

稳定：

```text
Built-in
User
Project
```

但注册本身不能通过同名覆盖产生行为差异。

load order 只影响：

```text
Hook order
Context equal-priority order
```

并应该记录在 Trace。

---

# 73. Phase 规划

## E0 — Contract Skeleton

新增：

```text
contract/
host/
registry/
```

定义：

```text
Manifest
ExtensionAPI
Contribution types
Disposable
Capability
Permission
```

不加载第三方代码。

---

## E1 — 内建 Adapter Dogfood

让：

```text
MCP
Skills
```

通过新 Registry 注册。

保持功能无变化。

---

## E2 — Hooks Adapter

`packages/hooks` 暴露 HookContribution Adapter。

Extension Host 可以：

```text
注册 in-process hook
```

Shell hooks 保持原配置机制。

---

## E3 — Context API

把：

```text
Skill
Memory
Project Rule
```

统一接入 Context Contributor。

Context Builder 不再分别硬编码多个来源。

---

## E4 — Agent / Workflow Contribution

加入：

```text
AgentProfileContribution
WorkflowStepContribution
```

现有 builtin Profile 使用同一 Registry。

---

## E5 — Provider Contribution

Provider Registry API v1。

支持：

```text
builtin
user configured
extension registered
```

统一 capability negotiation。

---

## E6 — Trusted Code Loader

增加：

```text
~/.jojo/extensions
.jojo/extensions
```

TOFU + permission manifest。

---

## E7 — API v1 Freeze

条件：

- MCP 使用 Tool Contribution；
- Skill 使用 Context Contribution；
- Hook 可由 Extension 注册；
- Agent Profile 使用 Registry；
- Workflow Step 使用 Registry；
- Provider 有稳定 Contribution；
- Extension 无法访问 Runtime Store；
- 权限/Trust 测试完整；
- Desktop 能显示 Extension 状态；
- crash/reload lifecycle 测试通过。

---

# 74. Extension Contract Freeze Checklist

## Identity

- [ ] Extension id
- [ ] Extension version
- [ ] Extension API version
- [ ] Contribution id

## Lifecycle

- [ ] discover
- [ ] trust
- [ ] activate
- [ ] drain
- [ ] deactivate
- [ ] dispose

## Capability

- [ ] Tool
- [ ] Hook
- [ ] Context
- [ ] Provider
- [ ] Memory
- [ ] Agent Profile
- [ ] Workflow Step

## Security

- [ ] capability declaration
- [ ] permission declaration
- [ ] hard deny priority
- [ ] TOFU
- [ ] secret isolation
- [ ] project fingerprint

## Runtime Boundary

- [ ] no Runtime Store access
- [ ] no Reducer access
- [ ] no Operation mutation
- [ ] no Electron direct dependency
- [ ] no permission bypass

---

# 75. 最终目录建议

```text
packages/
├── agent/
├── agent-runtime/
├── extensions/
│   └── src/
│       ├── contract/
│       ├── host/
│       ├── registry/
│       ├── capability/
│       ├── permissions/
│       ├── loader/
│       ├── trust/
│       ├── storage/
│       ├── testing/
│       └── adapters/
│
├── hooks/
├── providers/
├── orchestration/
├── storage/
├── tools-node/
├── browser/
└── apps/
```

---

# 76. 最终依赖关系

```text
                       Runtime Contract
                             ▲
                             │
                      Extension Host
                             │
       ┌─────────────────────┼────────────────────┐
       ▼                     ▼                    ▼
      MCP                   Hooks               Skills
       │                     │                    │
       └──────────────┬──────┴───────┬────────────┘
                      ▼              ▼
                 Tool Registry   Context Registry

       Providers ───────────────> Provider Registry
       Memory ──────────────────> Memory Registry
       Agent Profiles ──────────> Agent Registry
       Workflow Steps ──────────> Workflow Registry
```

Runtime 只消费 Registry/Port 的结果。

---

# 77. 最终决策

Jojo 不应该把 Extension 理解为：

```text
一个可以 require() 的 TS 文件
```

而应该理解为：

> **一组通过版本化 Contract 向 Jojo 注册能力的 Contribution。**

因此：

```text
MCP
Skill
Hook
Provider
Memory
Agent Profile
Workflow Step
```

虽然实现方式不同，但对 Runtime 来说最终都是：

```text
受控能力注册
```

这会让 Jojo 从：

```text
功能很多的 Desktop Agent
```

真正进入：

```text
可长期扩展的 General Agent Platform
```

一句话：

> **Extension Contract v1 的目标不是“插件越多越好”，而是保证未来新增任何能力都不再需要修改 Runtime Kernel。**
