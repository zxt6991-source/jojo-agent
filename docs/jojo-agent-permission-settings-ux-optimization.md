# Jojo Agent 权限设置页 UX 优化方案

> 项目：[`zxt6991-source/jojo-agent`](https://github.com/zxt6991-source/jojo-agent)  
> 分析基线：`main`，2026-09-18  
> 代码基线 Tree SHA：`64e71d377c0a851d9d9e02929036f531ceb29f00`  
> 目标：在**不削弱现有 Permission Governance 安全边界、不重写底层权限引擎**的前提下，显著降低普通用户配置权限时的心智负担。

---

## 1. 结论摘要

当前 Jojo Agent 的权限体系在工程上已经比较完整，但权限设置页仍然更像一个 **Permission Governance 调试控制台**，而不是一个面向普通用户的“权限偏好设置”。

问题并不只是“页面控件太多”，更核心的是：

1. 把内部实现概念直接暴露给用户：
   - `Policy Profile`
   - `Global / Workspace`
   - `ASK / AUTO / YOLO`
   - `Rules JSON`
   - `actors / triggers / sources / operations / risks / network / hasSecrets / resourceScope`
   - `reasonCode / actorKind / triggerKind / locked`
2. 同一个页面同时承载四种不同任务：
   - 选择日常权限策略；
   - 理解不可绕过的安全边界；
   - 编写细粒度规则；
   - 调试 / 审计权限决策。
3. 用户需要理解底层 Policy DSL 和规则优先级，才能放心修改权限。
4. `Workspace` 的继承关系不够直观：当前项目没有独立 Profile 时，Mode 实际继承 Global，但 Rules 编辑器又显示空文档，容易让用户误判“当前到底继承了什么”。
5. `Recent Decisions` 更适合开发者诊断，却占据普通设置页的一等位置。
6. 当前审批弹窗已经提供“允许一次 / 允许类似命令 / 本次对话都允许”，但设置页与运行时审批没有形成完整的学习闭环。

### 核心优化方向

建议把用户心智模型从：

```text
Scope
  ↓
Mode
  ↓
Policy JSON
  ↓
8 个 Match 维度
  ↓
优先级
  ↓
Audit
```

改成：

```text
Jojo 遇到某类操作
        ↓
它会怎么做？
        ↓
自动执行 / 询问我 / 阻止
```

普通用户只需要理解三件事：

```text
1. 我希望 Jojo 多大程度自动执行？
2. 哪些特殊行为我要单独设规则？
3. 最近 Jojo 为什么询问 / 自动执行 / 拒绝？
```

底层现有的：

```text
Hard Floor
Mandatory Approval
User Policy
Session Grant
Mode
Baseline Gate
```

继续保留，不需要为了 UX 改写。

---

# 2. 当前实现分析

## 2.1 当前页面结构

当前权限设置页位于：

```text
apps/desktop/src/renderer/PermissionsSettings.tsx
```

页面主要由两部分组成：

```text
权限
├── Policy Profile
│   ├── Global / Workspace
│   ├── revision
│   ├── ASK / AUTO / YOLO
│   ├── YOLO Warning
│   ├── Rules JSON
│   └── 保存 Policy
│
└── Recent Decisions
    ├── ALLOW / ASK / DENY
    ├── toolName
    ├── reasonCode
    ├── source
    ├── actorKind
    ├── triggerKind
    ├── locked
    ├── risk
    └── time
```

这套结构与项目最初的权限治理设计基本一致。

相关设计文档：

```text
docs/Jojo-Agent-Permission-Governance.md
```

其中 M1.7 UI 的原始设计本身就是：

```text
Permission Mode

○ ASK
○ AUTO
○ YOLO

Rules
Recent Decisions
```

也就是说：

> 当前页面不是“实现偏离了设计”，而是原设计更偏向工程能力暴露，尚缺少一层真正面向用户的 Product UX。

---

## 2.2 当前权限引擎实际上已经分层得很好

核心权限决策位于：

```text
packages/permission-governance/src/engine.ts
```

当前真实优先级为：

```text
1. Baseline DENY / Security Boundary
2. Hard Floor
3. User Policy DENY
4. Mandatory Approval
5. User Policy ASK
6. Session Grant
7. User Policy ALLOW
8. Permission Mode
9. Baseline fallback
```

这是一个非常好的底层安全模型。

因此本次优化不建议修改这个顺序。

### 应该改变的是：

```text
底层仍然复杂
        ↓
UI 不再要求用户理解底层复杂度
```

而不是：

```text
为了 UI 简单
        ↓
把底层安全体系也简单化
```

---

# 3. 当前用户心智负担来自哪里

## 3.1 把“实现概念”当成了“用户概念”

例如当前用户会看到：

```text
Policy Profile
Global
Workspace
ASK
AUTO
YOLO
Rules JSON
Recent Decisions
```

而普通用户真正想表达的是：

```text
“修改项目代码可以直接做。”

“联网命令还是先问我。”

“定时任务不要使用密钥。”

“这个项目可以比其他项目更自动一点。”
```

两者之间有明显的抽象层级差。

---

## 3.2 Rules JSON 是当前最大的认知门槛

Canonical Schema 位于：

```text
packages/contracts/src/persistence.ts
```

一条规则可以匹配：

```text
actors
triggers
sources
tools
operations
risks
network
hasSecrets
resourceScope
```

再加上：

```text
id
effect
```

意味着普通用户至少要理解：

- Actor 是什么；
- Trigger 是什么；
- Source 和 Tool 有什么区别；
- Operation 和 Tool 为什么还要同时存在；
- Risk 谁定义；
- `network = host` 是什么意思；
- `hasSecrets` 指的是哪类密钥；
- `resourceScope` 与 Workspace 有什么区别；
- Workspace Rule 与 Global Rule 谁优先；
- DENY 为什么又跨 Scope 优先；
- 同一个 Scope 内多条规则的顺序有什么影响。

这已经接近“编写 ACL / Policy DSL”，不应该成为普通用户设置权限的默认方式。

---

## 3.3 Policy 匹配顺序存在隐含知识

`packages/permission-governance/src/policy/policy-engine.ts` 中：

```text
DENY：
任意匹配规则都优先

ALLOW / ASK：
Workspace 优先于 Global

同一 Scope：
取最先匹配规则
```

因此：

```json
{
  "version": 1,
  "rules": [
    {
      "id": "rule-a",
      "effect": "allow",
      "match": {}
    },
    {
      "id": "rule-b",
      "effect": "ask",
      "match": {}
    }
  ]
}
```

规则顺序本身就具有语义。

但当前 UI 没有：

```text
冲突提示
规则命中模拟
顺序说明
规则优先级可视化
```

这会让 JSON 编辑器既难用，也容易产生“我明明配置了，为什么没生效”的问题。

---

# 4. 当前页面混合了 4 套不同心智模型

建议明确区分：

| 层 | 本质 | 用户是否应直接配置 |
|---|---|---|
| Security Boundary | 系统不可突破的安全边界 | 否 |
| Mandatory Approval | 无论模式如何都必须确认 | 否 |
| Permission Mode | 用户日常自动化偏好 | 是 |
| Custom Policy | 特殊场景例外 | 高级用户 |
| Audit | 解释 / 排查历史决策 | 查看即可 |

当前页面的问题是几乎把它们放在同一视觉层级。

---

# 5. 优化后的产品模型

## 5.1 一级心智模型：只问用户“什么时候需要确认”

建议将权限设置页核心问题改成：

> **控制 Jojo 什么时候需要先询问你。**

不再首先解释 Policy、Scope、Rule。

---

## 5.2 建议的页面一级结构

```text
权限

[权限策略] [活动记录]
```

### 权限策略

```text
应用范围
确认策略
当前行为
例外规则
系统保护
高级设置
```

### 活动记录

```text
权限行为摘要
最近记录
筛选
详情
```

把当前 `Recent Decisions` 从主配置区域拆出去。

---

# 6. 新版权限页面线框图

```text
┌─────────────────────────────────────────────────────┐
│ 权限                                                │
│ 控制 Jojo 什么时候需要先询问你。系统安全边界始终有效。 │
│                                                     │
│ [权限策略]    [活动记录]                            │
├─────────────────────────────────────────────────────┤
│                                                     │
│ 应用范围                                            │
│                                                     │
│  ● 所有项目                                         │
│  ○ 当前项目：jojo-agent                             │
│                                                     │
│  当前项目目前：继承“所有项目”的设置                 │
│  [为此项目单独设置]                                 │
│                                                     │
├─────────────────────────────────────────────────────┤
│ 确认策略                                            │
│                                                     │
│ ○ 每次确认                                          │
│   修改文件、运行命令等敏感操作通常先询问。          │
│                                                     │
│ ● 智能自动                                          │
│   项目内明确低风险的操作自动执行，其余先询问。      │
│                                                     │
│ ○ 尽量自动                                          │
│   普通审批自动通过，系统保护操作仍会询问或阻止。    │
│                                                     │
├─────────────────────────────────────────────────────┤
│ 按当前设置，Jojo 会：                               │
│                                                     │
│ 项目内读取                  自动执行                 │
│ 项目内修改                  自动 / 依策略            │
│ 本地命令                    低风险自动，其余询问     │
│ 联网与外部操作              视风险询问               │
│ 系统保护操作                始终询问或阻止           │
│                                                     │
├─────────────────────────────────────────────────────┤
│ 例外规则                                      + 添加 │
│                                                     │
│ ⛔ 定时任务使用密钥                                 │
│    阻止                                             │
│                                                     │
│ ❓ 终端使用主机网络                                 │
│    每次询问                                         │
│                                                     │
│ [查看全部 2 条规则]                                 │
│                                                     │
├─────────────────────────────────────────────────────┤
│ 系统保护                                            │
│                                                     │
│ Jojo 永远不会让用户策略绕过这些限制：               │
│ · 工作区外写入：阻止                               │
│ · 工作区外访问：需要确认                           │
│ · 安装 Skill：需要确认                             │
│ · 信任项目 Hooks：需要确认                         │
│ · 网络 + 密钥：需要确认                            │
│                                                     │
│ [了解更多]                                          │
│                                                     │
├─────────────────────────────────────────────────────┤
│ ▸ 高级设置                                          │
│    JSON Policy / Revision / 原始决策信息            │
└─────────────────────────────────────────────────────┘
```

---

# 7. ASK / AUTO / YOLO 改成“结果导向”的文案

底层枚举不需要修改：

```ts
type PermissionMode =
  | 'ask'
  | 'auto'
  | 'yolo';
```

仅修改 UI Label。

建议：

| 内部值 | 当前名称 | 新 UI 名称 |
|---|---|---|
| `ask` | ASK | 每次确认 |
| `auto` | AUTO | 智能自动 |
| `yolo` | YOLO | 尽量自动 |

高级说明中仍可以显示：

```text
技术名称：ASK
技术名称：AUTO
技术名称：YOLO
```

这样：

- 不破坏内部命名；
- 不破坏存储；
- 不破坏 API；
- 不破坏测试；
- 普通用户也不需要理解 YOLO 是什么意思。

---

# 8. 模式选择不能只显示一句描述

当前 AUTO 文案：

> 自动执行确定性的低风险操作。

问题是：

用户仍然不知道：

```text
“什么算低风险？”
```

建议每个模式点击后直接展示“行为预览”。

例如 AUTO：

```text
智能自动

✓ 项目文件读取：自动
✓ 项目内修改：自动
✓ 隔离环境中的普通命令：自动
? 高风险命令：询问
? 工作区外访问：询问
? 网络 + 密钥：询问
× 工作区外写入：阻止
```

这比解释：

```text
risk = medium
sandbox = strong
network = none
hasSecrets = false
```

更符合用户心智。

---

# 9. 基于当前代码的行为矩阵

按照现有：

```text
packages/permission-governance/src/modes/mode-evaluator.ts
packages/permission-governance/src/hard-floor/evaluator.ts
packages/tools-node/src/default-permission-gate.ts
```

可以直接生成如下用户可理解的说明：

| 操作 | 每次确认 | 智能自动 | 尽量自动 |
|---|---|---|---|
| 项目内读取 | 自动 | 自动 | 自动 |
| 项目内修改 | 询问 | 自动 | 自动 |
| 普通隔离 Terminal | 询问 | 自动 | 自动 |
| 高风险 Terminal | 询问 | 询问 | 自动* |
| 工作区外读取 | 询问 | 询问 | 询问 |
| 工作区外写入 | 阻止 | 阻止 | 阻止 |
| Skill 安装 | 询问 | 询问 | 询问 |
| 信任项目 Hooks | 询问 | 询问 | 询问 |
| 网络 + 密钥 Terminal | 询问 | 询问 | 询问 |

`*` 仍然受 Hard Floor、Mandatory Approval、Sandbox 和其他 Domain Security Gate 限制。

这张表建议作为“了解模式区别”的二级内容，而不是让用户看 Rule Schema。

---

# 10. Global / Workspace 重构

## 10.1 当前问题

现在 UI 是：

```text
[Global] [Workspace]
```

这要求用户先理解 Scope。

建议改成：

```text
应用范围

● 所有项目
○ 当前项目：jojo-agent
```

用户更容易理解。

---

## 10.2 Workspace 默认应该明确显示“继承”

当前存储逻辑中：

```text
Workspace Profile 不存在
        ↓
Mode 使用 Global
```

但 UI 当前：

```text
Mode：
显示继承后的 Global Mode

Rules JSON：
显示空 rules
```

用户很容易产生以下疑问：

```text
“模式继承了，那规则有没有继承？”
“这里空是不是说明 Global Rule 不生效？”
“保存一下是不是就覆盖全局了？”
```

建议当前项目页显示显式状态：

```text
当前项目
jojo-agent

✓ 正在继承“所有项目”的权限设置

[为此项目单独设置]
```

只有点击：

```text
为此项目单独设置
```

才创建 Workspace Profile。

---

## 10.3 增加“恢复继承全局”

当前 Storage 只有：

```ts
saveProfile()
```

但缺少真正的：

```ts
deleteWorkspaceProfile()
```

建议新增：

```ts
resetWorkspacePermissionPolicy({
  workingDirectory
})
```

语义：

```text
删除对应 Workspace Profile
        ↓
重新继承 Global
```

这比保存一份“看起来和 Global 一样”的复制配置更干净。

---

# 11. Rules JSON 改造成“例外规则”

## 11.1 普通用户不再直接看到 JSON

默认：

```text
例外规则

+ 添加例外规则
```

而不是：

```text
Rules JSON
<textarea />
```

---

## 11.2 一条规则展示为自然语言

例如现在：

```json
{
  "id": "deny-scheduler-secret",
  "effect": "deny",
  "match": {
    "triggers": ["scheduler"],
    "hasSecrets": true
  }
}
```

展示为：

```text
定时任务使用密钥

当：
  由“定时任务”触发
  并且操作需要密钥

处理：
  阻止
```

普通用户完全不需要知道：

```text
trigger=scheduler
hasSecrets=true
effect=deny
```

---

# 12. 新增例外规则使用两步式 Builder

不要一开始把 8 个 match 字段全部铺开。

建议：

## 第一步：什么行为？

```text
你想控制哪类操作？

○ 修改项目文件
○ 运行本地命令
○ 使用网络
○ 操作浏览器 / 外部服务
○ 使用 MCP
○ 定时任务
○ Sub-Agent / Workflow
○ 访问项目外文件
○ 其他高级条件
```

## 第二步：怎么处理？

```text
遇到这种行为时：

○ 自动执行
● 每次询问
○ 阻止
```

然后：

```text
[保存规则]
```

---

# 13. 高级条件才展开底层字段

点击：

```text
更多条件
```

才显示：

```text
执行者
触发方式
工具来源
具体工具
操作类型
风险等级
网络
是否使用密钥
资源范围
```

也就是映射当前 Schema：

```text
actors
triggers
sources
tools
operations
risks
network
hasSecrets
resourceScope
```

这样仍然保留现有 Policy 的全部表达能力。

---

# 14. 为常见场景提供模板

建议优先提供：

```text
项目内文件修改 → 自动执行

Terminal 使用主机网络 → 每次询问

Terminal 使用密钥 → 每次询问

Scheduler 使用密钥 → 阻止

浏览器产生外部副作用 → 每次询问

MCP 外部副作用 → 每次询问

Sub-Agent 修改当前工作区 → 自动执行
```

用户通常不应该从“空白 ACL”开始配置。

---

# 15. 规则列表必须解决“顺序”问题

当前同一 Scope 内：

```text
第一个匹配到的 ALLOW / ASK 可能决定结果
```

而 DENY 又具有更高优先级。

所以新版 Rule Builder 至少要显示：

```text
规则按顺序匹配

拖动调整优先级
```

并且在可能冲突时提示：

```text
⚠ 这条规则可能永远不会命中，
因为上面的“所有 Terminal → 自动执行”范围更广。
```

---

# 16. 更好的方案：用户根本不需要管理大多数规则

运行时审批弹窗已经有：

```text
允许一次
允许类似命令
本次对话都允许
```

相关代码：

```text
apps/desktop/src/renderer/main.tsx
packages/permission-governance/src/grants/grant-store.ts
```

这本身已经是非常好的“渐进式授权”入口。

建议进一步增加一个产品闭环：

```text
用户连续多次批准同类操作
        ↓
Jojo 提示：
“你已经多次允许 pnpm test，
是否以后在这个项目自动允许？”
        ↓
[保持每次确认]
[此项目自动允许]
```

注意：

> 不应该自动创建持久权限，只提供建议，由用户明确确认。

---

# 17. 持久规则不要由前端随意推导

如果未来支持：

```text
“此项目以后自动允许”
```

不要在 Renderer 根据 Audit Metadata 自己拼一条规则。

建议由 Permission Governance 后端提供：

```ts
derivePermissionRuleFromDecision(...)
```

原因：

前端很容易漏掉：

```text
actor
trigger
network
secret names
sandbox requirement
MCP fingerprint
resource scope
```

从而生成比用户原始授权范围更宽的规则。

正确方式：

```text
Approval / Audit
      ↓
Governance Backend
      ↓
生成最小权限 Rule Draft
      ↓
UI 让用户确认
      ↓
Persist Policy
```

---

# 18. Recent Decisions 改成“权限活动”

当前：

```text
Recent Decisions
ALLOW
terminal
auto_low_risk
mode · main / user
medium
```

这是很典型的工程日志。

普通用户更需要：

```text
已自动执行
pnpm test

因为：
你使用“智能自动”，这个命令在隔离环境中运行，
不联网，也不读取密钥。

2 分钟前
```

---

# 19. 活动记录的两层信息结构

## 第一层：给普通用户

```text
结果
行为
一句人话解释
时间
```

例如：

```text
✓ 已自动允许

运行 pnpm test

智能自动允许了隔离环境中的普通命令。

19:42
```

---

## 第二层：详情抽屉

点击：

```text
查看技术详情
```

再展示：

```text
Effect: allow
Tool: terminal
Risk: medium
Source: mode
Reason Code: auto_low_risk
Actor: main
Trigger: user
Locked: false
Sandbox: strong
Network: none
```

这样开发者能力仍然完整保留。

---

# 20. reasonCode 需要人类可读映射

例如：

```ts
const reasonMessage = {
  auto_low_risk:
    '当前操作被判断为低风险，因此由智能自动模式执行。',

  workspace_boundary:
    '该操作尝试写入当前项目之外的位置，已被系统阻止。',

  outside_workspace_requires_confirmation:
    '访问当前项目之外的文件需要你的确认。',

  network_and_secret_requires_confirmation:
    '该操作同时申请网络与密钥访问，因此必须由你确认。',

  skill_install_requires_confirmation:
    '安装 Skill 会改变 Jojo 的能力，因此必须确认。',

  project_hook_trust_requires_confirmation:
    '项目 Hooks 可以运行本地逻辑，信任前必须确认。'
}
```

技术 `reasonCode` 只放在详情中。

---

# 21. Audit 页面增加摘要

例如：

```text
最近 24 小时

自动执行     38
询问          6
阻止          1
```

再按类型显示：

```text
Terminal       14
文件修改       11
Browser         8
MCP             7
其他            5
```

用户可以快速知道：

> “到底是什么在频繁打断我？”

这也是项目原 Permission Governance 文档中 Audit 的真正价值之一。

---

# 22. “系统保护”必须单独展示，但不能伪装成设置项

当前用户容易把：

```text
YOLO
```

理解成：

```text
“所有东西都不再问了”
```

而实际不是。

当前代码中以下行为仍受到系统保护：

```text
工作区外写入
工作区外访问
安装 Skill
信任 Project Hooks
critical + weak sandbox
host network + secret
```

建议页面明确显示：

```text
系统保护
```

并加锁图标：

```text
🔒 无法通过权限设置关闭
```

而不是把这些做成 Disabled Switch。

因为 Disabled Switch 仍会给用户产生：

> “为什么我不能打开？”

的额外认知负担。

---

# 23. 高级设置保留 Raw JSON

Raw JSON 不应该删除。

它对：

```text
开发者
高级用户
测试
调试
快速复制策略
```

仍然非常有价值。

但入口应调整为：

```text
高级设置
  ├── Policy JSON
  ├── Revision
  ├── Effective Policy
  └── 原始 Audit 信息
```

默认折叠。

---

# 24. JSON 与可视化规则必须共用同一 Source of Truth

建议继续使用当前：

```ts
PermissionPolicyDocumentSchema
```

不要重新设计第二套独立配置模型。

架构：

```text
Rule Builder
     │
     ▼
PermissionPolicyDocument
     ▲
     │
JSON Editor
```

两种编辑方式都操作同一个 Document。

好处：

- 兼容现有数据；
- 不需要 DB Migration；
- 不会形成 UI Config 和 Runtime Policy 两套真相；
- 现有 Engine 无需修改。

---

# 25. 不建议把每一个 Rule 字段做成普通表单

一种看似简单的方案是：

```text
Effect: [allow]
Actor: [...]
Trigger: [...]
Source: [...]
Tools: [...]
Operations: [...]
Risks: [...]
Network: [...]
Secrets: [...]
Resource Scope: [...]
```

这实际上只是：

> 把 JSON 编辑器换成了 Form 编辑器。

心智负担仍然存在。

正确方向应该是：

```text
常见意图
   ↓
映射成 Rule
```

而不是：

```text
Rule Schema
   ↓
换一种 UI 排版
```

---

# 26. 建议新增“当前策略效果”而不是解释内部算法

例如：

```text
当前项目：jojo-agent

有效策略来源：

确认模式：
所有项目 → 智能自动

例外规则：
所有项目 → 2 条
当前项目 → 1 条

系统保护：
始终生效
```

用户只需要知道“最终效果来自哪里”。

不需要知道：

```text
PermissionPolicyEngine
ResolvedPermissionPolicy
workspaceRules
globalRules
```

---

# 27. 建议后端增加 Effective Policy Snapshot

目前 Snapshot：

```ts
{
  global,
  workspace?,
  recentDecisions
}
```

建议逐步增加：

```ts
{
  global,
  workspace?,

  effective: {
    mode: 'ask' | 'auto' | 'yolo',
    modeSource: 'global' | 'workspace',

    globalRuleCount: number,
    workspaceRuleCount: number,

    workspaceOverridesGlobal: boolean
  },

  recentDecisions
}
```

Renderer 不应该自己推断：

```text
“这个 Mode 是继承还是 Workspace 自己配置的？”
```

应该由后端给出确定答案。

---

# 28. 建议新增 Workspace Reset API

### Contract

```ts
ResetWorkspacePermissionPolicyInputSchema
```

### Desktop API

```ts
resetWorkspacePermissionPolicy({
  workingDirectory
})
```

### Storage

```ts
deleteProfile(
  scope: 'workspace',
  scopeKey: string
)
```

### UI

```text
恢复继承所有项目设置
```

---

# 29. Rule CRUD 第一阶段不需要新 API

当前 API：

```ts
savePermissionPolicy({
  scope,
  mode,
  document
})
```

已经足够支撑：

```text
新增规则
修改规则
删除规则
调整规则顺序
```

前端可以：

```text
读取整个 document
      ↓
修改 rules[]
      ↓
整份保存
```

因此 P0 不需要重构 Storage。

---

# 30. 后续可以增加 Rule Explain / Conflict API

P1 可以增加：

```ts
analyzePermissionPolicy(document)
```

返回：

```ts
{
  warnings: [
    {
      ruleId: 'x',
      type: 'shadowed',
      message: '该规则可能被前面的更宽规则覆盖'
    }
  ]
}
```

这样可解决：

```text
Rule 顺序
Rule 冲突
永不命中
范围过宽
```

等高级问题。

---

# 31. 设置页和运行时审批形成闭环

建议未来流程：

```text
Tool Call
   ↓
需要审批
   ↓
用户看到人类可读原因
   ↓
允许一次
   ├─ 允许类似操作（本次会话）
   ├─ 本次对话允许
   └─ 以后在当前项目这样处理
               ↓
         Rule Draft Preview
               ↓
          用户明确保存
```

权限设置页由此从：

```text
“用户必须先学会权限模型”
```

变成：

```text
“规则会在实际使用中自然生长”
```

这非常适合 Agent 产品。

---

# 32. Composer 中现有权限 Badge 也可以利用

当前输入框区域已有：

```text
⌁ 权限 ASK
⌁ 权限 AUTO
⌁ 权限 YOLO
```

建议让它可以点击：

```text
⌁ 权限 · 智能自动
        ↓
┌─────────────────────┐
│ 当前：智能自动       │
│                     │
│ ○ 每次确认           │
│ ● 智能自动           │
│ ○ 尽量自动           │
│                     │
│ 权限详细设置 →       │
└─────────────────────┘
```

这样用户不需要：

```text
设置
→ 权限
→ 找模式
```

才能临时调整偏好。

---

# 33. 推荐的新组件拆分

目前：

```text
PermissionsSettings.tsx
```

承担过多职责。

建议拆成：

```text
PermissionsSettings.tsx

permissions/
├── PermissionScopeSelector.tsx
├── PermissionModeSelector.tsx
├── PermissionBehaviorPreview.tsx
├── PermissionSystemGuards.tsx
├── PermissionRulesList.tsx
├── PermissionRuleEditor.tsx
├── PermissionActivity.tsx
├── PermissionActivityDetail.tsx
├── PermissionAdvancedEditor.tsx
├── permission-copy.ts
├── permission-rule-presenter.ts
└── permission-rule-builder.ts
```

其中：

```text
permission-copy.ts
```

统一维护：

```text
reasonCode → 用户文案
source → 用户文案
risk → 用户文案
mode → 用户文案
```

避免各页面散落英文术语。

---

# 34. 第一阶段最好不要修改底层 Schema

当前：

```ts
PermissionPolicyDocumentSchema
```

以及 SQLite：

```text
permission_policy_profiles
permission_decision_audit
```

都可以继续使用。

原因：

现有 Schema 已经：

- 可版本化；
- deterministic；
- 能表达现有需求；
- 已有测试；
- 已与 Engine、Audit、IPC 对齐。

本次主要问题：

> 不是权限模型表达能力不足，而是 UI 直接暴露了权限模型。

所以 P0 应以 UX Adapter 为主。

---

# 35. P0：低风险 UX 改造

目标：

> 不改 Governance Engine，不改 SQLite Schema，先把 80% 的心智负担拿掉。

### P0.1 页面结构

改成：

```text
权限策略
活动记录
```

---

### P0.2 Mode 文案

```text
ASK  → 每次确认
AUTO → 智能自动
YOLO → 尽量自动
```

---

### P0.3 Scope 文案

```text
Global    → 所有项目
Workspace → 当前项目
```

---

### P0.4 行为预览

根据 Mode 显示：

```text
项目读取
项目修改
Terminal
外部操作
系统保护
```

---

### P0.5 Rule List

JSON 转成人类可读 Card。

例如：

```text
定时任务 + 使用密钥
→ 阻止
```

---

### P0.6 Advanced

JSON Editor 移入：

```text
高级设置
```

---

### P0.7 Audit

Recent Decisions 移到：

```text
活动记录
```

默认人类可读，技术字段放详情。

---

# 36. P1：补齐权限产品能力

建议增加：

```text
Workspace Profile Reset
Effective Policy Snapshot
Policy Conflict Analysis
Audit → Rule Draft
```

---

# 37. P2：基于真实使用降低审批疲劳

可以基于 Audit：

```text
过去 N 次同类行为
```

发现用户经常重复批准：

```text
pnpm test
npm test
go test
读取固定目录
某个已信任 MCP 的只读 Tool
```

提示：

```text
你最近 5 次都允许了 “pnpm test”。

是否：
[继续每次询问]
[本次对话允许]
[当前项目自动允许]
```

必须保证：

```text
默认不自动扩大权限
用户必须明确确认
生成规则范围不得宽于已有授权语义
```

---

# 38. 不建议做的几种方案

## 38.1 只把 JSON 折叠起来

不够。

因为：

```text
Global / Workspace
ASK / AUTO / YOLO
Audit 技术字段
```

仍然存在。

---

## 38.2 把 JSON 换成 10 个下拉框

不够。

只是：

```text
Policy DSL
```

变成：

```text
Policy Form
```

用户仍然必须懂 DSL。

---

## 38.3 增加更多 Tooltip

Tooltip 解决不了信息架构问题。

如果一个页面需要大量 Tooltip 才能解释：

```text
actor
trigger
source
resourceScope
```

说明这些字段本来就不应该出现在第一层。

---

## 38.4 用“安全等级 1～5”

不建议。

因为 Jojo 的真实权限模型不是线性的安全等级。

例如：

```text
YOLO
```

也不能绕过：

```text
Hard Floor
Mandatory Approval
```

用数字等级反而会误导。

---

## 38.5 把 Mandatory Approval 变成用户 Switch

不建议。

这些是安全边界，而不是偏好。

应该展示：

```text
系统保护
```

而不是：

```text
[ ] 开启强制审批
```

---

# 39. 建议的文案体系

## 页面标题

```text
权限
```

副标题：

```text
控制 Jojo 什么时候需要先询问你。
系统安全边界始终有效。
```

---

## Mode

### 每次确认

```text
修改文件、运行命令等敏感操作通常先询问。
```

### 智能自动

```text
项目内明确低风险的操作自动执行，其余先询问。
```

### 尽量自动

```text
普通审批自动通过；系统保护操作仍会询问或阻止。
```

---

# 40. 活动记录文案示例

## auto_low_risk

```text
已自动执行

这个操作满足“智能自动”的低风险条件。
```

## workspace_boundary

```text
已阻止

该操作尝试写入当前项目之外的位置。
```

## outside_workspace_requires_confirmation

```text
需要确认

该操作要访问当前项目之外的文件。
```

## network_and_secret_requires_confirmation

```text
需要确认

该命令同时申请网络访问和密钥使用。
```

## skill_install_requires_confirmation

```text
需要确认

安装 Skill 会改变 Jojo 可使用的能力。
```

## project_hook_trust_requires_confirmation

```text
需要确认

项目 Hooks 可以执行项目提供的自动化逻辑。
```

---

# 41. 兼容现有策略数据

现有用户已经可能保存：

```json
{
  "version": 1,
  "rules": [...]
}
```

新版 UI 应：

```text
直接读取
  ↓
解析成 Rule Cards
```

而不是 Migration 成另一种格式。

无法映射为常用模板的复杂 Rule：

```text
高级规则
```

例如：

```text
高级规则

Workflow + Browser + External Effect
→ 每次询问

[查看条件]
```

不要丢失任何字段。

---

# 42. 保存策略

建议仍保持当前：

```text
用户编辑
  ↓
点击保存
```

而不是第一阶段改成全页面自动保存。

权限本身属于高影响设置。

显式保存具有价值：

```text
保存更改
```

同时可以增加：

```text
你有未保存的更改
```

离开页面时提示即可。

---

# 43. Revision 的位置

当前：

```text
revision 2
```

直接出现在主页面。

普通用户通常不需要。

建议放入：

```text
高级设置
  Policy Version: v1
  Revision: 2
  Last Updated: ...
```

---

# 44. Workspace Path 的位置

当前直接显示完整路径：

```text
/Users/xxx/projects/jojo-agent
```

主页面建议只显示：

```text
当前项目：jojo-agent
```

完整路径放：

```text
title
详情
```

这样视觉更干净。

---

# 45. 建议的安全边界解释方式

不要解释：

```text
Hard Floor
Mandatory Approval
```

而是：

```text
系统保护
```

例如：

```text
这些操作无法被“尽量自动”关闭：

• 向项目外写入文件：始终阻止
• 读取项目外文件：始终确认
• 安装 Skill：始终确认
• 信任项目 Hooks：始终确认
• 命令同时使用主机网络和密钥：始终确认
```

技术术语仅放：

```text
了解工作原理
```

中。

---

# 46. 测试改造建议

目前：

```text
apps/desktop/src/renderer/permissions-settings.test.ts
```

主要测试：

```text
JSON Validation
Scope Rendering
Recent Decisions
```

新版需要增加：

## Mode

```text
ask → 每次确认
auto → 智能自动
yolo → 尽量自动
```

---

## Scope

```text
Global → 所有项目
Workspace missing → 继承所有项目
Workspace exists → 当前项目单独设置
Reset → 回到继承
```

---

## Rule Presenter

```text
scheduler + hasSecrets + deny
↓
定时任务使用密钥 → 阻止
```

---

## Rule Builder Round Trip

```text
UI
↓
PermissionPolicyDocument
↓
UI
```

字段必须无损。

---

## Existing JSON Compatibility

任意合法：

```text
PermissionPolicyDocumentSchema
```

必须可以：

```text
加载
编辑
保存
```

---

## DENY Priority

新版 UI 不得错误暗示：

```text
Workspace ALLOW
```

可以覆盖：

```text
Global DENY
```

---

## E2E

建议增加：

```text
apps/desktop/e2e/permission-settings.spec.ts
```

覆盖：

```text
切换 Mode
Workspace Override
恢复继承
添加例外规则
修改规则顺序
Advanced JSON
Activity Detail
```

---

# 47. UX 成功指标

上线前后可以观察：

| 指标 | 期望变化 |
|---|---|
| 权限设置首次完成时间 | 降低 |
| JSON Validation Error | 显著降低 |
| 打开 Advanced JSON 的用户比例 | 降低 |
| 重复审批次数 | 降低 |
| 用户回滚 / 清空 Policy 次数 | 降低 |
| 权限相关问题反馈 | 降低 |
| 查看 Audit 后仍无法理解原因的反馈 | 降低 |

同时安全指标必须保持：

```text
Hard Floor 无绕过
Mandatory Approval 无绕过
Grant 不扩大原权限
项目文件不能自授权
```

---

# 48. 推荐实施顺序

## PR 1：纯前端信息架构

```text
PermissionsSettings
├── 权限策略 / 活动记录
├── Mode 新文案
├── Scope 新文案
├── Behavior Preview
├── System Guards
└── Advanced JSON
```

不改后端。

---

## PR 2：可视化 Rule Presenter

```text
PermissionRule → HumanReadableRule
```

现有 JSON Policy 继续作为唯一 Source of Truth。

---

## PR 3：Rule Builder

先支持高频模板。

复杂规则仍进入 Advanced。

---

## PR 4：Workspace Reset + Effective Snapshot

补：

```text
resetWorkspacePermissionPolicy
effective policy source
```

---

## PR 5：Activity UX

```text
reasonCode humanization
filters
summary
detail drawer
```

---

## PR 6：Approval → Persistent Rule

新增：

```text
从实际批准行为生成最小权限 Rule Draft
```

这一步必须由 Governance Backend 生成。

---

# 49. 对现有工程的影响评估

## 可以不修改

```text
packages/permission-governance/src/engine.ts
packages/permission-governance/src/modes/mode-evaluator.ts
packages/permission-governance/src/hard-floor/evaluator.ts
packages/permission-governance/src/policy/policy-engine.ts
packages/tools-node/src/default-permission-gate.ts
packages/tools-node/src/terminal-security-policy.ts
```

这些都是已经建立好的安全语义。

---

## P0 主要修改

```text
apps/desktop/src/renderer/PermissionsSettings.tsx
apps/desktop/src/renderer/permissions-settings.test.ts
apps/desktop/src/renderer/styles.css
```

建议新增：

```text
apps/desktop/src/renderer/permissions/*
```

---

## P1 以后修改

```text
packages/contracts/src/desktop.ts
apps/desktop/src/main/main.ts
packages/storage/src/sqlite-permission-governance-store.ts
```

主要用于：

```text
Workspace Reset
Effective Policy Snapshot
Policy Analysis
```

---

# 50. 最终推荐方案

这次优化最重要的一点，不是：

> **把现有权限页面重新排版。**

而是：

> **不要再要求普通用户直接操作 Permission Governance 的内部模型。**

Jojo 当前的底层权限体系其实已经具备：

```text
安全边界
强制审批
Policy
Grant
Mode
Audit
```

现在缺的只是一个：

```text
User Mental Model Adapter
```

推荐最终形成：

```text
普通用户
   │
   ├── 确认策略
   ├── 行为结果预览
   └── 少量例外规则
           │
           ▼
      UX Adapter
           │
           ▼
PermissionPolicyDocument
           │
           ▼
Permission Governance Engine
```

而高级用户仍然可以：

```text
高级设置
   ↓
Raw JSON Policy
   ↓
完整 Audit
```

这样可以同时满足：

```text
普通用户：不需要学习 Policy DSL
高级用户：不损失任何控制能力
开发者：底层架构基本不用重构
安全性：Hard Floor / Mandatory Approval 完全保留
```

---

# 51. 一句话版本

> **把“权限设置”从 ACL / Policy 编辑器，重构成“Jojo 遇到什么操作时要不要问我”的用户偏好页面；底层复杂度保留，界面复杂度隐藏。**

