# Jojo Agent Permission Governance 实现设计

> 建议文件：`docs/jojo-permission-governance-implementation-design.md`  
> 基线：`main`  
> 状态：Implementation Design / M1  
> 目标：在不破坏现有 Tool、Sandbox、MCP、Workflow、Approval 架构的前提下，引入统一、可审计、可扩展的 Permission Governance。

---

# 1. 背景

Jojo 当前已经具备比较完整的“工具执行安全链”：

```text
Agent
  ↓
PermissionGate
  ↓
allow / ask / deny
  ↓
Approval
  ↓
Tool.execute()
  ↓
Sandbox / Workspace Boundary / MCP Security
```

当前已经存在：

- `DefaultPermissionGate`
- `MemoryPermissionGate`
- `ExtensionPermissionGate`
- `BrowserPermissionGate`
- `OrchestrationPermissionGate`
- `ConversationGrantPermissionGate`
- `NonInteractivePermissionGate`
- `ServerApprovalBroker`
- Terminal Security Policy
- Process Sandbox
- MCP Server Trust
- Browser Recording Trust

这些模块本身不应该被 Permission Governance 替换。

真正的问题在于：

> **现在有 Permission Gates，但还没有统一的 Permission Governance。**

各模块分别决定：

```text
allow
ask
deny
```

但系统还缺乏统一回答以下问题的能力：

```text
为什么允许？
为什么拒绝？
这是谁允许的？
这个授权能持续多久？
AUTO 模式应该放过什么？
YOLO 能不能绕过安全边界？
后台 Agent 和人工交互 Agent 是否应该执行同样的策略？
Scheduler 触发的 Agent 遇到审批怎么办？
MCP、Browser、Terminal 能否统一到同一权限模型？
```

因此，本设计的目标不是重新开发 PermissionGate，而是在现有 PermissionGate 之上建立：

```text
Permission Governance Engine
```

---

# 2. 设计目标

Permission Governance 应最终成为以下所有执行来源的统一权限决策中心：

```text
Main Agent
Sub-Agent
Workflow
Scheduler
API
CLI
Browser
MCP
Hooks
未来 Team Agent
```

目标架构：

```text
                    Tool Call
                        │
                        ▼
              Domain Security Gate
                        │
           ┌────────────┴────────────┐
           │                         │
      security facts           baseline decision
           │                         │
           └────────────┬────────────┘
                        ▼
              Permission Governance
                        │
       ┌────────────────┼────────────────┐
       ▼                ▼                ▼
   Hard Floor       User Policy        Grants
       │                │                │
       └────────────────┼────────────────┘
                        ▼
                  Mode Policy
               ASK / AUTO / YOLO
                        │
          ┌─────────────┼─────────────┐
          ▼             ▼             ▼
        ALLOW           ASK           DENY
                        │
                        ▼
                Approval Broker
                        │
                        ▼
                 Tool Execution
                        │
                        ▼
                Sandbox / Runtime
```

---

# 3. 非目标

Permission Governance **不负责**：

- 实际执行 Tool；
- 实现 Linux Bubblewrap / macOS Seatbelt；
- 检查 Git Worktree；
- 实现 MCP Transport；
- 解析浏览器页面；
- 替代 TerminalSecurityPolicy；
- 替代 MCP Trust；
- 替代 Approval UI；
- 替代 Workflow Tool Policy。

这些仍由各 Domain Security Module 负责。

Permission Governance 只回答：

```text
在已经知道这个操作是什么、有什么风险的情况下：

这个 Actor 在这个 Context 下，
现在是否允许执行这个操作？
```

---

# 4. 核心原则

## 4.1 Safety Boundary 优先于 User Policy

任何用户配置都不能突破系统安全边界。

例如：

```text
workspace escape
invalid symlink resolution
unsafe SSRF target
sandbox unavailable under strict requirements
invalid MCP trust identity
Sub-Agent profile 明确禁止的 capability
```

即使：

```text
mode = YOLO
```

也必须拒绝。

因此：

```text
Hard Deny > User Policy > Mode
```

---

## 4.2 Grant 不能绕过 Security Gate

当前 Conversation Grant 的思路需要调整。

错误模型：

```text
Grant exists
   ↓
直接 allow
   ↓
跳过 Base PermissionGate
```

正确模型：

```text
Base Security Check
        ↓
如果 DENY
        ↓
   永远 DENY

如果 ASK
        ↓
检查 Grant
        ↓
可能变 ALLOW
```

即：

> Grant 只能消除“是否需要再次人工确认”，不能消除底层安全校验。

---

# 5. Permission Governance 的四层模型

统一划分成四层：

```text
L0 Security Boundary
L1 Mandatory Approval
L2 User Policy
L3 Runtime Mode
```

外加一个：

```text
Session Grant
```

---

# 6. L0：Security Boundary

L0 是不可绕过层。

第一阶段不要急着把现有安全代码搬进 Governance。

直接规定：

```text
legacy/domain PermissionGate 返回 deny
=
Governance locked deny
```

例如当前：

```text
DefaultPermissionGate
TerminalSecurityPolicy
ExtensionPermissionGate
BrowserPermissionGate
MemoryPermissionGate
Orchestration Tool Policy
```

如果返回：

```ts
{
  decision: 'deny'
}
```

Governance 必须转换成：

```ts
{
  effect: 'deny',
  locked: true,
  source: 'security_boundary'
}
```

任何后续：

```text
Policy
Grant
AUTO
YOLO
Reviewer
```

均不得修改结果。

---

# 7. L1：Mandatory Approval

某些操作不需要禁止，但是也不应该因为用户打开 YOLO 就静默执行。

定义：

```text
Mandatory Approval
```

即：

```text
无论 ASK / AUTO / YOLO
都必须人工确认
```

M1 建议包含：

### 工作区之外读取

```text
read_file outside workspace
```

### 项目 Hooks 信任

```text
trust_project_hooks
```

### Skill 安装

```text
install_skill
```

### 高危 Terminal 组合

例如：

```text
risk = critical
AND sandbox = soft | none
```

或者：

```text
network = host
AND secretEnv.length > 0
```

这类操作存在明显的数据外泄风险。

### 不可信外部自动化

例如：

```text
Browser Recording
external side effects
untrusted project automation
```

以后也可以加入：

```text
credential export
persistent external write
financial action
delete remote resource
```

因此：

```text
Hard Deny
    ↓
Mandatory Ask
    ↓
Policy / Grant / Mode
```

---

# 8. L2：User Policy

用户可以定义：

```text
allow
ask
deny
```

例如：

```yaml
version: 1

mode: ask

rules:

  - id: allow-pnpm-test
    effect: allow
    match:
      source: native
      tool: terminal
      executable: pnpm
      subcommand: test
      network: none
      secrets: false

  - id: ask-terminal-network
    effect: ask
    match:
      source: native
      tool: terminal
      network: host

  - id: deny-scheduler-secrets
    effect: deny
    match:
      trigger: scheduler
      capabilities:
        any:
          - credential:secret
```

---

# 9. V1 不建议加载 `.jojo/permissions.yml`

第一版不建议允许仓库直接提供：

```text
<repo>/.jojo/permissions.yml
```

并自动获得：

```text
allow
```

否则恶意仓库完全可能携带：

```yaml
rules:
  - effect: allow
    match:
      tool: terminal
```

这会形成：

```text
被处理的项目
    ↓
自己定义允许 Agent 如何处理自己
```

这是错误的信任关系。

因此 V1：

```text
用户 Permission Policy
    ↓
保存在本地 SQLite / ~/.jojo
```

而不是受控项目目录。

未来如果支持：

```text
.jojo/permissions.yml
```

只能：

### 方案 A

项目 Policy 只能收紧：

```text
allow → ask
allow → deny
ask  → deny
```

不能放宽权限。

或者：

### 方案 B

跟 Hooks 一样：

```text
content fingerprint
      ↓
user trust
      ↓
才允许 policy 生效
```

推荐优先采用 A。

---

# 10. L3：Permission Mode

增加三个用户模式：

```ts
type PermissionMode =
  | 'ask'
  | 'auto'
  | 'yolo';
```

UI：

```text
ASK
AUTO
YOLO
```

---

## 10.1 ASK

默认模式。

原则：

```text
保持 Jojo 当前行为
```

如果 Base Gate：

```text
ALLOW → ALLOW
ASK   → ASK
DENY  → DENY
```

Session Grant 可以消除重复 ASK。

---

## 10.2 AUTO

AUTO 不是：

```text
自动批准所有 ASK
```

而是：

```text
自动批准“确定性判断为低风险”的 ASK
```

推荐自动允许：

### Workspace 文件修改

```text
write_file
edit_file
delete_file
```

条件：

```text
target inside workspace
AND prepared diff exists
AND no mandatory approval
```

### Terminal

条件：

```text
risk == medium
AND network == none
AND secretEnv.length == 0
AND sandbox IN [strong, container]
```

例如：

```text
pnpm test
npm test
go test ./...
cargo test
eslint
vitest
tsc
```

AUTO 不自动允许：

```text
risk = high
risk = critical
network = host
secretEnv != []
outside workspace
external side effect
```

---

# 11. YOLO

YOLO 表示：

```text
只要 Security Boundary 不拒绝，
并且不属于 Mandatory Approval，
则自动执行。
```

也就是说：

```text
YOLO != disable security
```

而是：

```text
YOLO = disable ordinary interactive approval
```

非常重要。

即：

```text
Hard Deny
   ↓
Mandatory Ask
   ↓
YOLO
   ↓
Allow
```

---

# 12. 最终决策顺序

必须固定，不能让各 Gate 自由定义优先级。

建议：

```text
1. Base Security Decision
2. Hard Floor
3. Explicit DENY Policy
4. Mandatory Approval
5. Explicit ASK Policy
6. Session Grant
7. Explicit ALLOW Policy
8. Permission Mode
9. Baseline fallback
```

伪代码：

```ts
async function evaluate(
  request: GovernanceRequest
): Promise<GovernanceDecision> {

  if (request.baseline.decision === 'deny') {
    return lockedDeny('security_boundary');
  }

  const hardFloor = hardFloorEvaluator.evaluate(request);

  if (hardFloor) {
    return lockedDeny(hardFloor.reason);
  }

  const explicit = policyEngine.match(request);

  if (explicit?.effect === 'deny') {
    return deny('user_policy', explicit.id);
  }

  const mandatory = mandatoryApproval.evaluate(request);

  if (mandatory) {
    return askLocked(mandatory.reason);
  }

  if (explicit?.effect === 'ask') {
    return ask('user_policy', explicit.id);
  }

  if (grantStore.allows(request)) {
    return allow('session_grant');
  }

  if (explicit?.effect === 'allow') {
    return allow('user_policy', explicit.id);
  }

  return modeEvaluator.evaluate(request);
}
```

---

# 13. 新 Package

建议新建：

```text
packages/permission-governance/
```

目录：

```text
packages/permission-governance/
├── package.json
├── src/
│   ├── index.ts
│   ├── types.ts
│   ├── engine.ts
│   ├── runtime-permission-gate.ts
│   │
│   ├── normalization/
│   │   ├── normalizer.ts
│   │   ├── native.ts
│   │   ├── terminal.ts
│   │   ├── mcp.ts
│   │   ├── browser.ts
│   │   └── orchestration.ts
│   │
│   ├── policy/
│   │   ├── schema.ts
│   │   ├── matcher.ts
│   │   ├── defaults.ts
│   │   └── policy-engine.ts
│   │
│   ├── hard-floor/
│   │   ├── evaluator.ts
│   │   └── mandatory-approval.ts
│   │
│   ├── grants/
│   │   ├── grant-store.ts
│   │   ├── fingerprint.ts
│   │   └── conversation-grants.ts
│   │
│   ├── modes/
│   │   ├── mode-evaluator.ts
│   │   └── auto-policy.ts
│   │
│   └── audit/
│       ├── audit.ts
│       └── redaction.ts
│
└── test/
    ├── engine.test.ts
    ├── hard-floor.test.ts
    ├── grants.test.ts
    ├── policy.test.ts
    ├── modes.test.ts
    └── runtime-permission-gate.test.ts
```

---

# 14. 核心数据模型

## 14.1 GovernanceContext

不要重新创造 Runtime Context。

基于现有：

```ts
RuntimeResolutionContext
```

转换：

```ts
export interface GovernanceContext {
  sessionId: string;
  laneId: string;
  runId: string;

  actor: {
    kind: 'main' | 'subagent' | 'workflow';
    id?: string;
    profile?: string;
  };

  trigger: {
    kind:
      | 'user'
      | 'api'
      | 'workflow'
      | 'subagent'
      | 'scheduler'
      | 'resume';
  };

  workingDirectory: string;

  executionScope: ExecutionScope;

  interactive: boolean;
}
```

注意：

```text
scheduler
```

不是 Actor。

比如：

```text
Scheduler
   ↓
启动 Main Agent
```

应该表示：

```ts
actor.kind = 'main'
trigger.kind = 'scheduler'
```

不要把 scheduler 塞进：

```ts
RuntimeActor.kind
```

---

# 15. GovernanceFacts

统一描述“这个操作具有什么安全属性”。

```ts
export type GovernanceRisk =
  | 'low'
  | 'medium'
  | 'high'
  | 'critical';

export type ToolSource =
  | 'native'
  | 'mcp'
  | 'browser'
  | 'memory'
  | 'orchestration'
  | 'skill'
  | 'hook';

export type OperationKind =
  | 'read'
  | 'write'
  | 'execute'
  | 'network'
  | 'external_effect'
  | 'install'
  | 'trust'
  | 'control';

export interface GovernanceFacts {
  source: ToolSource;

  operations: OperationKind[];

  risk: GovernanceRisk;

  capabilities: string[];

  resourceScope:
    | 'workspace'
    | 'outside_workspace'
    | 'external'
    | 'none';

  terminal?: {
    executable: string;
    subcommand?: string;

    network: 'none' | 'host';

    secretEnv: string[];

    sandbox:
      | 'strong'
      | 'container'
      | 'soft'
      | 'none';
  };

  mcp?: {
    serverId: string;

    serverFingerprint?: string;

    toolName: string;

    risk:
      | 'read'
      | 'external_side_effect';
  };

  browser?: {
    origin?: string;

    externalEffect: boolean;
  };
}
```

---

# 16. GovernanceRequest

```ts
export interface GovernanceRequest {
  id: string;

  call: ToolCall;

  context: GovernanceContext;

  baseline: PermissionDecision;

  facts: GovernanceFacts;

  fingerprint: string;
}
```

---

# 17. GovernanceDecision

不要直接把现有：

```ts
PermissionDecision
```

扩展成几十个字段。

保持 Agent 层 Contract 简单。

Governance 内部使用：

```ts
export interface GovernanceDecision {
  id: string;

  effect:
    | 'allow'
    | 'ask'
    | 'deny';

  locked: boolean;

  source:
    | 'security_boundary'
    | 'hard_floor'
    | 'mandatory_approval'
    | 'user_policy'
    | 'session_grant'
    | 'mode'
    | 'baseline';

  reasonCode: string;

  reason: string;

  policyRuleId?: string;

  requestFingerprint: string;

  grantKey?: string;
}
```

最后 Adapter 再转换：

```text
GovernanceDecision
        ↓
PermissionDecision
```

---

# 18. Runtime 接入方式

当前 Runtime 已经允许注入：

```ts
RuntimePermissionGate
```

因此实现：

```ts
export class GovernanceRuntimePermissionGate
  implements RuntimePermissionGate {

  constructor(
    private readonly baseline: RuntimePermissionGate,
    private readonly normalizer: PermissionRequestNormalizer,
    private readonly engine: PermissionGovernanceEngine,
    private readonly audit: PermissionAuditSink
  ) {}

  async check(
    call: ToolCall,
    context: RuntimeResolutionContext
  ): Promise<PermissionDecision> {

    const baseline =
      await this.baseline.check(call, context);

    const request =
      await this.normalizer.normalize({
        call,
        context,
        baseline
      });

    const decision =
      await this.engine.evaluate(request);

    await this.audit.record({
      request,
      decision
    });

    return toPermissionDecision(
      request,
      decision
    );
  }
}
```

---

# 19. 不要重写现有 Gate

第一阶段当前链：

```text
ConversationGrant
      ↓
Orchestration
      ↓
Browser
      ↓
Extension / MCP
      ↓
Memory
      ↓
DefaultPermissionGate
```

迁移后：

```text
GovernanceRuntimePermissionGate
             │
             ▼
      Existing Security Gates
             │
             ▼
        Baseline Decision
             │
             ▼
       Governance Engine
```

也就是说：

> 先把现有 Gate 当作 Domain Security Preflight。

等 Governance 稳定以后，再逐渐把：

```text
ConversationGrant
MCP Session Grant
NonInteractivePermissionGate
```

里面真正属于“Policy”的逻辑搬出来。

---

# 20. Grant 重构

这是本阶段最值得修正的部分之一。

目前应统一：

```text
ConversationPermissionGrants
McpSessionPermissionGrants
```

为：

```ts
export interface PermissionGrantStore {
  find(
    request: GovernanceRequest
  ): PermissionGrant | undefined;

  grant(
    request: GovernanceRequest,
    scope: GrantScope
  ): void;

  clearSession(sessionId: string): void;
}
```

---

# 21. GrantScope

```ts
export type GrantScope =
  | 'once'
  | 'similar'
  | 'conversation';
```

注意：

```text
conversation
```

表示生命周期。

不代表：

```text
本次对话所有 Tool 全部放行
```

---

# 22. 删除 conversation 全局 bool

不建议继续使用：

```ts
type SessionGrants = {
  conversation: boolean;
  similar: Set<string>;
}
```

因为：

```text
conversation = true
```

粒度太大。

改成：

```ts
type SessionGrants = {
  fingerprints: Set<string>;
  classes: Set<string>;
}
```

例如：

```text
similar:
terminal:pnpm:test:cwd=.:network=none

conversation:
native:file-write:workspace
```

---

# 23. Grant Fingerprint

Terminal：

```text
tool
executable
subcommand
cwd scope
network
secret names
sandbox requirement
actor
```

例如：

```text
terminal
pnpm
test
.
none
[]
strong
main
```

生成：

```text
SHA256(canonical JSON)
```

---

## MCP

必须包含：

```text
server security fingerprint
tool name
risk
```

例如：

```text
mcp:
  serverFingerprint=xxx
  tool=create_issue
  risk=external_side_effect
```

MCP 配置变化后：

```text
fingerprint changed
        ↓
旧 Grant 自动失效
```

---

# 24. Permission Policy Schema

建议用 Zod 作为 Canonical Schema。

```ts
const PermissionRuleSchema = z.object({
  id: z.string(),

  effect: z.enum([
    'allow',
    'ask',
    'deny'
  ]),

  match: z.object({
    actors: z.array(
      z.enum([
        'main',
        'subagent',
        'workflow'
      ])
    ).optional(),

    triggers: z.array(
      z.enum([
        'user',
        'api',
        'scheduler',
        'workflow',
        'subagent',
        'resume'
      ])
    ).optional(),

    sources: z.array(
      z.enum([
        'native',
        'mcp',
        'browser',
        'memory',
        'orchestration',
        'skill',
        'hook'
      ])
    ).optional(),

    tools: z.array(
      z.string()
    ).optional(),

    operations: z.array(
      z.enum([
        'read',
        'write',
        'execute',
        'network',
        'external_effect',
        'install',
        'trust',
        'control'
      ])
    ).optional(),

    risks: z.array(
      z.enum([
        'low',
        'medium',
        'high',
        'critical'
      ])
    ).optional(),

    network: z.enum([
      'none',
      'host'
    ]).optional(),

    hasSecrets: z.boolean().optional(),

    resourceScope: z.enum([
      'workspace',
      'outside_workspace',
      'external',
      'none'
    ]).optional()
  }).strict()
}).strict();
```

V1 不建议支持：

```text
JavaScript expressions
arbitrary regex
shell regex
user supplied evaluator
```

Policy 必须保持确定性。

---

# 25. Policy Scope

V1：

```text
Global User Policy
Workspace User Policy
```

均来自 Jojo 本地数据。

优先级：

```text
Hard Security
        ↓
User DENY
        ↓
Mandatory ASK
        ↓
Workspace Rule
        ↓
Global Rule
        ↓
Grant
        ↓
Mode
```

如果 workspace/global 同时匹配：

```text
DENY 永远优先
```

对于：

```text
ALLOW vs ASK
```

优先使用更具体的：

```text
Workspace Rule
```

---

# 26. Policy Persistence

建议不要第一版做复杂 relational rule table。

直接保存 Versioned Policy Document。

SQLite：

```sql
CREATE TABLE permission_policy_profiles (
    id TEXT PRIMARY KEY,

    scope TEXT NOT NULL,
    scope_key TEXT,

    mode TEXT NOT NULL,

    document_json TEXT NOT NULL,

    revision INTEGER NOT NULL,

    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

例如：

```text
id = global
scope = global
```

或者：

```text
id = workspace:<hash>
scope = workspace
scope_key = <canonical workspace identity>
```

---

# 27. Permission Audit

新增：

```text
permission_decision_audit
```

```sql
CREATE TABLE permission_decision_audit (
    id TEXT PRIMARY KEY,

    created_at TEXT NOT NULL,

    session_id TEXT NOT NULL,
    lane_id TEXT,
    run_id TEXT,

    actor_kind TEXT,
    actor_id TEXT,

    trigger_kind TEXT,

    tool_name TEXT NOT NULL,
    tool_source TEXT NOT NULL,

    effect TEXT NOT NULL,
    locked INTEGER NOT NULL,

    source TEXT NOT NULL,
    reason_code TEXT NOT NULL,

    policy_rule_id TEXT,

    request_fingerprint TEXT NOT NULL,

    risk TEXT NOT NULL,

    approval_id TEXT,

    metadata_json TEXT
);
```

---

# 28. Audit 不保存敏感数据

禁止直接持久化：

```text
API Key
Password
Authorization Header
Secret value
完整 Terminal env
Cookie value
```

Terminal 建议仅保存：

```text
executable
subcommand
cwd scope
network mode
secret variable names
risk
sandbox strength
```

比如：

```text
OPENAI_API_KEY
```

名字可以保存。

值：

```text
sk-xxxxxxxx
```

绝对不能保存。

---

# 29. ApprovalRequest 扩展

现有 `ApprovalRequest` 可以增加一个 optional 字段：

```ts
governance?: {
  decisionId: string;

  requestFingerprint: string;

  source:
    | 'mandatory_approval'
    | 'user_policy'
    | 'mode'
    | 'baseline';

  reasonCode: string;

  risk:
    | 'low'
    | 'medium'
    | 'high'
    | 'critical';

  locked: boolean;

  policyRuleId?: string;
}
```

这样 UI 可以显示：

```text
为什么需要审批
```

例如：

```text
Terminal requests host network + secret access.

Mode:
AUTO

Decision:
Manual approval required

Reason:
network_and_secret_requires_confirmation
```

---

# 30. ApprovalBroker 保持不变

不要让 Governance 自己等待用户。

保持：

```text
Governance
   ↓
ASK
   ↓
ApprovalRequest
   ↓
ServerApprovalBroker
```

这样现有：

```text
Desktop
REST
WebSocket
Remote Approval
```

全部继续工作。

---

# 31. Approval Persistence 增强

当前 Approval persistence 已经有：

```text
sessionId
laneId
runId
toolCallId
toolName
reason
requestHash
status
decision
resolvedBy
```

建议增加：

```text
governance_decision_id
request_fingerprint
policy_revision
governance_source
reason_code
risk
```

这样以后 Scheduler 恢复时可以判断：

```text
这个 Approval
到底对应哪一个确定性的权限判断
```

---

# 32. AUTO 规则实现

新增：

```ts
export class AutoPermissionPolicy {

  isEligible(
    request: GovernanceRequest
  ): boolean {

    const { facts } = request;

    if (
      facts.resourceScope ===
      'outside_workspace'
    ) {
      return false;
    }

    if (facts.terminal) {

      return (
        facts.terminal.network === 'none'
        &&
        facts.terminal.secretEnv.length === 0
        &&
        (
          facts.terminal.sandbox === 'strong'
          ||
          facts.terminal.sandbox === 'container'
        )
        &&
        facts.risk === 'medium'
      );
    }

    if (
      facts.operations.includes('external_effect')
    ) {
      return false;
    }

    if (
      facts.operations.includes('write')
      &&
      facts.resourceScope === 'workspace'
    ) {
      return true;
    }

    return false;
  }
}
```

---

# 33. 不要让 LLM Reviewer 进入 M1

Permission Governance M1 **不要加入 Reviewer Agent**。

即不要：

```text
Tool
 ↓
LLM 判断危险吗？
 ↓
allow
```

原因：

- 不确定性；
- 增加 Token 成本；
- 增加延迟；
- Reviewer 也可能被 Prompt Injection；
- 难以写确定性测试；
- Scheduler 无人值守场景需要稳定语义。

第一阶段：

```text
Deterministic Rules Only
```

以后可以增加：

```text
Risk Reviewer
```

但 Reviewer 只能：

```text
ALLOW candidate
      ↓
ASK
```

或者：

```text
ASK
 ↓
提供风险说明
```

不能：

```text
DENY → ALLOW
Hard Ask → ALLOW
```

---

# 34. Sub-Agent 权限迁移

当前 `NonInteractivePermissionGate` 不应该长期承担 Governance。

目标：

```text
Sub-Agent
    ↓
actor.kind = subagent
profile = general
interactive = false
executionScope = worktree
    ↓
Governance
```

例如：

```text
general Sub-Agent
```

可以有 Built-in Policy：

```yaml
- id: general-worktree-write
  effect: allow

  match:
    actors:
      - subagent

    operations:
      - write

    resourceScope: workspace
```

Terminal：

```text
medium
network=none
strong sandbox
worktree
```

也可以自动执行。

但：

```text
host network
secret
outside workspace
external side effect
```

仍然拒绝或者等待上层审批。

---

# 35. Tool Policy 与 Governance 的关系

Sub-Agent Profile Tool Policy：

```text
“这个 Agent 有没有这个 Tool”
```

Permission Governance：

```text
“有 Tool 后，这一次调用是否允许”
```

因此：

```text
Profile Capability
        ↓
Tool available?
        ↓
NO → Tool 根本不存在

YES
 ↓
Permission Governance
 ↓
ALLOW / ASK / DENY
```

不要混成同一个系统。

---

# 36. MCP 权限迁移

现有：

```text
ExtensionPermissionGate
McpSessionPermissionGrants
```

逐步改成：

```text
ExtensionPermissionGate
       ↓
只负责：
MCP security facts
MCP trust boundary
readOnlyHint
server fingerprint
external-side-effect classification

       ↓
Permission Governance
       ↓
统一处理 Grant / Policy / Mode
```

最终：

```text
McpSessionPermissionGrants
```

可以删除。

---

# 37. Browser 权限迁移

Browser Gate 同理。

Browser 模块负责判断：

```text
origin
navigation
upload
cookie
download
external effect
recording trust
```

Governance 决定：

```text
allow
ask
deny
```

这样未来：

```text
AUTO
YOLO
Scheduler
```

不需要 Browser 自己重新实现模式逻辑。

---

# 38. Workflow

Workflow 启动本身属于：

```text
orchestration.control
```

Workflow 内部 Tool Call：

```text
仍然逐个进入 Permission Governance
```

不要：

```text
批准 workflow_start
=
批准 workflow 内所有操作
```

两层必须独立。

---

# 39. Scheduler 预留

Permission Governance 做完以后，Scheduler 接入就会非常简单。

例如：

```text
Scheduler
   ↓
Runtime Run
```

传入：

```ts
trigger.kind = 'scheduler'
interactive = false
```

Agent 调用：

```text
read_file
```

可能：

```text
ALLOW
```

调用：

```text
terminal pnpm test
```

AUTO Policy：

```text
ALLOW
```

调用：

```text
terminal
network=host
secretEnv=[GITHUB_TOKEN]
```

Governance：

```text
ASK
```

Scheduler/Job Runtime：

```text
RUNNING
   ↓
WAITING_APPROVAL
```

用户之后批准：

```text
WAITING_APPROVAL
       ↓
RUNNING
```

这就是 Scheduler 所需要的权限基础。

---

# 40. 推荐的文件变更

## 新增

```text
packages/permission-governance/
```

---

## 修改

### `packages/contracts/src/agent.ts`

增加：

```text
ApprovalRequest.governance?
```

不要修改现有：

```text
PermissionDecision
PermissionGate
```

的基本语义。

---

### `apps/desktop/src/worker/worker.ts`

当前：

```text
ConversationGrantPermissionGate
 └─ Orchestration
     └─ Browser
         └─ Extension
             └─ Memory
                 └─ Native
```

第一阶段改成：

```text
GovernanceRuntimePermissionGate
        │
        ▼
LegacyCompositePermissionGate
        │
        ├─ Orchestration
        ├─ Browser
        ├─ Extension
        ├─ Memory
        └─ Native
```

Conversation Grant 从 Legacy Chain 移出。

---

### `apps/desktop/src/worker/session-permission-grants.ts`

第一阶段：

```text
Deprecated Adapter
```

第二阶段删除。

逻辑迁到：

```text
packages/permission-governance/src/grants/
```

---

### `packages/extensions/src/permission-gate.ts`

删除：

```text
McpSessionPermissionGrants
```

MCP Grant 交给统一 GrantStore。

---

### `packages/orchestration/src/permission-gate.ts`

逐渐删除：

```text
NonInteractivePermissionGate
```

的：

```text
ask → auto allow
```

逻辑。

保留真正属于：

```text
Sub-Agent capability boundary
Workflow security preflight
```

的部分。

---

### `packages/app-service/src/persistence.ts`

增加：

```ts
PermissionPolicyStore
PermissionAuditStore
```

---

### `packages/storage`

增加：

```text
sqlite-permission-store.ts
```

或者整合到：

```text
sqlite-server-state-store.ts
```

推荐独立实现，避免 ServerStateStore 越来越臃肿。

---

# 41. Composition

最终：

```ts
const legacyGate =
  createExistingPermissionGate();

const governanceStore =
  new SqlitePermissionGovernanceStore(
    path.join(
      dataDirectory,
      'runtime',
      'permissions.sqlite'
    )
  );

const governanceEngine =
  new PermissionGovernanceEngine({
    policyStore: governanceStore,
    grantStore:
      new ConversationPermissionGrantStore(),

    hardFloor:
      new DefaultHardFloorEvaluator(),

    mandatoryApproval:
      new DefaultMandatoryApprovalEvaluator()
  });

const permissionGate =
  new GovernanceRuntimePermissionGate(
    legacyGate,
    governanceEngine,
    governanceStore
  );
```

然后：

```ts
runtimeEnvironments.bind(
  sessionId,
  'main',
  {
    permissions: permissionGate
  }
);
```

---

# 42. Migration Strategy

不要一次删掉所有 PermissionGate。

采用 Shadow Migration。

## M1.1 Governance Facade

新增：

```text
permission-governance
```

但是：

```text
mode = ASK
```

所有 baseline：

```text
allow → allow
ask → ask
deny → deny
```

要求：

> 行为完全不变。

---

# 43. M1.2 Audit

开始记录：

```text
permission decision
```

但不改变结果。

这阶段可以验证：

```text
当前哪些工具在 ask
哪些在 allow
哪些在 deny
```

---

# 44. M1.3 Grant Migration

把：

```text
ConversationPermissionGrants
McpSessionPermissionGrants
```

迁入统一：

```text
PermissionGrantStore
```

此阶段重点测试：

```text
Grant 永远不能覆盖 baseline deny
```

---

# 45. M1.4 Policy

增加：

```text
Global Policy
Workspace Policy
```

初始默认无自定义规则。

---

# 46. M1.5 AUTO

增加：

```text
mode = auto
```

先只自动批准：

```text
workspace file mutation
medium terminal
network none
no secrets
strong/container sandbox
```

不要一开始覆盖 Browser/MCP side effect。

---

# 47. M1.6 YOLO

最后增加：

```text
mode = yolo
```

并确保：

```text
Hard Deny
Mandatory Ask
```

测试全部通过。

---

# 48. M1.7 UI

设置页：

```text
Permissions
```

建议：

```text
Permission Mode

○ ASK
  所有敏感操作请求确认

○ AUTO
  自动执行低风险操作

○ YOLO
  自动执行除强制审批和禁止操作外的所有操作
```

下方：

```text
Rules
Recent Decisions
```

---

# 49. Permission Audit UI

示例：

```text
ALLOW
terminal
pnpm test

Source:
AUTO policy

Risk:
medium

Sandbox:
strong

Network:
none
```

或者：

```text
DENY
terminal

Reason:
terminal_host_escape_denied

Source:
Security Boundary

Locked:
Yes
```

这个 UI 对调试 Agent 特别有价值。

---

# 50. 测试矩阵

必须重点覆盖：

| 场景 | ASK | AUTO | YOLO |
|---|---|---|---|
| workspace read | allow | allow | allow |
| workspace write | ask | allow | allow |
| terminal medium / no network | ask | allow | allow |
| terminal high | ask | ask | allow |
| terminal critical + soft sandbox | ask | ask | ask |
| terminal host network | ask | ask | allow |
| terminal host network + secret | ask | ask | ask |
| outside workspace read | ask | ask | ask |
| outside workspace write | deny | deny | deny |
| unsafe web URL | deny | deny | deny |
| MCP trusted read | allow | allow | allow |
| MCP external side effect | ask | ask | allow* |
| install skill | ask | ask | ask |
| trust project hooks | ask | ask | ask |

`*` 仍受 MCP Trust / Hard Floor 限制。

---

# 51. 必须增加的安全测试

## Grant 不能绕过 DENY

```ts
it(
  'conversation grant cannot bypass hard deny',
  ...
);
```

---

## Network 权限不能扩张

先批准：

```text
pnpm test
network=none
```

再请求：

```text
pnpm test
network=host
```

必须重新决策。

---

## Secret 权限不能扩张

先：

```text
secretEnv=[]
```

后：

```text
secretEnv=['GITHUB_TOKEN']
```

旧 Grant 不得匹配。

---

## MCP Fingerprint

Server 配置变化：

```text
fingerprint A
     ↓
fingerprint B
```

A 的 Grant 必须失效。

---

## Actor 不能扩张

给：

```text
main
```

的 Grant 不应该天然继承给：

```text
subagent
scheduler
```

---

## Project Policy 不能自授权

项目文件不能：

```text
自动把 terminal 从 ask 改成 allow
```

---

# 52. 建议新增测试文件

```text
packages/permission-governance/test/
├── engine.test.ts
├── precedence.test.ts
├── hard-floor.test.ts
├── mandatory-approval.test.ts
├── grant-fingerprint.test.ts
├── policy-matcher.test.ts
├── auto-mode.test.ts
├── yolo-mode.test.ts
├── audit-redaction.test.ts
└── runtime-adapter.test.ts
```

现有回归测试继续跑：

```text
packages/tools-node/test/
packages/extensions/test/
packages/orchestration/test/
packages/agent/test/tool-execution-safety.test.ts
apps/desktop/src/worker/session-permission-grants.test.ts
packages/app-service/test/approval-service.test.ts
```

---

# 53. 错误码规范

统一：

```text
permission_hard_denied
permission_policy_denied
permission_mandatory_approval
permission_user_denied
permission_grant_mismatch
permission_noninteractive
permission_policy_invalid
```

Domain Error 保留：

```text
terminal_host_escape_denied
sandbox_unavailable
unsafe_url
...
```

不要全部改成：

```text
permission_denied
```

否则可观察性会变差。

---

# 54. Observability

建议增加 metrics：

```text
permission_decisions_total{
  effect,
  source,
  tool_source
}
```

```text
permission_approvals_total{
  decision
}
```

```text
permission_grant_hits_total{
  scope
}
```

```text
permission_hard_denies_total{
  reason_code
}
```

后续可以看出：

```text
到底哪些审批最烦用户
```

再针对性优化 AUTO 策略。

---

# 55. 第一版验收标准

Permission Governance M1 完成必须满足：

### 架构

- [ ] 所有 Main Agent 工具最终经过 Governance。
- [ ] MCP / Browser / Native Tool 可以输出统一 Governance Facts。
- [ ] Base Security `deny` 不可被任何 Grant/Mode 覆盖。
- [ ] ApprovalBroker 不被重写。
- [ ] Agent Tool Execution Loop 不需要重构。

### Modes

- [ ] ASK 行为与当前 main 基本兼容。
- [ ] AUTO 仅自动允许明确低风险操作。
- [ ] YOLO 不能绕过 Hard Deny。
- [ ] Mandatory Approval 在 YOLO 下仍然生效。

### Grants

- [ ] 删除全局 `conversation=true` 式无限授权。
- [ ] Grant 基于稳定 fingerprint。
- [ ] network / secret / MCP fingerprint 变化导致旧 Grant 不匹配。

### Audit

- [ ] 每次权限决策存在 decision record。
- [ ] 可以追踪 session/run/tool。
- [ ] 审批与 Governance Decision 可关联。
- [ ] 不持久化 Secret value。

### Future

- [ ] `trigger=scheduler` 可以进入同一 Engine。
- [ ] Sub-Agent 可以使用 actor/profile Policy。
- [ ] Workflow Tool Call 无需单独实现 AUTO/YOLO。
- [ ] Headless Server 和 Desktop 使用同一 Governance Engine。

---

# 56. 推荐开发顺序

```text
PR 1
Permission Governance Contracts
+
Engine Skeleton
+
ASK compatibility mode
```

↓

```text
PR 2
GovernanceRuntimePermissionGate
+
Audit
+
Desktop Runtime 接入
```

↓

```text
PR 3
Unified GrantStore
+
Conversation Grant Migration
+
MCP Grant Migration
```

↓

```text
PR 4
User Policy Engine
+
SQLite Policy Store
```

↓

```text
PR 5
AUTO Mode
+
Mandatory Approval
```

↓

```text
PR 6
YOLO Mode
+
Permission Settings UI
```

↓

```text
PR 7
Sub-Agent / Workflow Governance Migration
```

完成后再进入：

```text
Scheduler
```

会比较顺。

---

# 57. 最终架构

Permission Governance 完成后的 Jojo：

```text
                       Jojo Runtime
                            │
                 ┌──────────┴──────────┐
                 │                     │
             Main Agent           Orchestrator
                                      │
                              ┌───────┴───────┐
                              │               │
                          Sub-Agent        Workflow
                              │               │
                              └───────┬───────┘
                                      │
                                      ▼
                                 Tool Call
                                      │
                                      ▼
                         Domain Security Layer
                                      │
                ┌─────────────────────┼─────────────────────┐
                │                     │                     │
             Native                  MCP                 Browser
                │                     │                     │
                └─────────────────────┼─────────────────────┘
                                      ▼
                          Permission Governance
                                      │
                      ┌───────────────┼───────────────┐
                      │               │               │
                 Hard Floor       User Policy       Grants
                      │               │               │
                      └───────────────┼───────────────┘
                                      ▼
                              ASK / AUTO / YOLO
                                      │
                         ┌────────────┼────────────┐
                         │            │            │
                       Allow         Ask          Deny
                                      │
                                      ▼
                               Approval Broker
                                      │
                                      ▼
                               Tool Execution
                                      │
                                      ▼
                            Process Sandbox /
                         MCP Runtime / Browser
```

---

# 58. 核心结论

Jojo 当前并不缺：

```text
PermissionGate
```

真正缺的是：

```text
Permission Governance
```

因此不应该重新开发一套：

```text
Tool → Permission → Approval
```

而应该利用 main 已经具备的：

```text
RuntimePermissionGate
ApprovalBroker
Security Preview
Process Sandbox
MCP Trust
Browser Trust
Run/Lane/Actor Context
```

在它们上面增加：

```text
                 Governance
                      │
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
    Hard Floor     User Policy     Grants
        │             │             │
        └─────────────┼─────────────┘
                      ▼
               ASK / AUTO / YOLO
                      │
                      ▼
                    Audit
```

其中最重要的约束是：

> **Permission Governance 可以减少审批，但永远不能削弱 Security Boundary。**

同时：

> **Grant 只能复用已经合法的授权，绝不能跳过安全验证。**

在这套基础完成后，Scheduler、Daemon、Persistent Team、Automation 都可以直接复用同一权限体系，而不需要各自重新实现一套“无人值守时能不能执行这个 Tool”的逻辑。