# Jojo Agent 团队设置页 UX 优化技术方案

> 项目：`zxt6991-source/jojo-agent`  
> 模块：Desktop Team Settings / Persistent Team  
> 方案版本：v1.1（代码核实修订版）  
> 日期：2026-09-13

---

## 0. v1.1 修订说明

v1.0 对 Persistent Team 现状的描述（第 1–14 节）已逐项对照实际源码核实：

```text
packages/contracts/src/orchestration.ts       — TeamDefinitionSchema / TeamMemberDefinitionSchema
apps/desktop/src/renderer/TeamSettings.tsx    — 现有成员编辑页字段
packages/orchestration/src/team/effective-config.ts — Provider/Model/ReadOnly 推导逻辑
packages/orchestration/src/team/manager.ts    — tools 字段的可选合并逻辑
```

核实结论：现状描述准确，架构策略（不改 Schema、加语义层）方向正确。基于核实过程中发现的细节偏差和风险点，对第 8、11、15、16、26 节做了修订，修订处均以 `> ⚠️ 修订说明` 标出，正文其余部分保持 v1.0 原意不变。

---

## 1. 背景

Jojo 当前 Persistent Team 已经具备较完整的运行能力：

- 长期保存团队与成员；
- 成员 Profile；
- Provider / Model 继承与覆盖；
- System Prompt；
- ReadOnly；
- Tool Allow / Deny；
- 子智能体派生；
- 团队并发；
- 成员启停；
- 任务队列和运行状态。

当前主要 UI：

```text
apps/desktop/src/renderer/TeamSettings.tsx
```

现有成员编辑页直接暴露：

```text
成员 ID
名称
Profile
描述
Provider
模型
系统提示词
工具允许列表
工具拒绝列表
只读成员
允许派生子智能体
允许派生的 Profile
最大活跃派生数
运行时启用
```

这使用户必须理解 Agent Runtime 的内部概念，才能组建一个团队。

问题的本质不是能力不足，而是：

> **Backend Schema 被直接映射成了最终用户表单。**

团队功能应该从“配置 Multi-Agent Runtime”转变为“组建 AI 团队”。

---

# 2. 优化目标

用户只需要回答三个问题：

```text
谁？
负责什么？
能做什么？
```

Jojo 自动推导：

```text
Profile
System Prompt
Tool Policy
Provider / Model
Spawn Policy
Concurrency
```

目标包括：

1. 普通用户无需理解 Profile；
2. 无需填写 Tool Allow / Deny；
3. 无需理解 Spawn Profile；
4. Provider / Model 默认继承；
5. ID 自动生成；
6. 并发默认自动；
7. 基础模式只展示用户能理解的业务语义；
8. 高级能力保留，但折叠到高级设置；
9. 配置和运行状态分离；
10. 尽量复用当前 Persistent Team Runtime，不做大规模底层重构。

---

# 3. 核心产品原则

## 3.1 职责优先

用户选择：

```text
分析
开发
审查
汇总
```

而不是：

```text
explore
general
code-review
synthesize
```

---

## 3.2 能力优先

用户选择：

```text
只能查看
可以修改项目
可以联网
可以执行命令
```

而不是：

```text
readOnly
tools.allow
tools.deny
```

---

## 3.3 继承优先

默认：

```text
Provider = 跟随当前项目
Model    = 跟随当前项目
```

利用当前 Runtime 已有逻辑：

```ts
member.providerId ?? input.providerId

member.model
  ?? profile.model
  ?? input.model
```

---

## 3.4 自动优先

普通用户不应该首先决定：

```text
Profile
System Prompt
Spawn Profiles
maxActive
maxConcurrency
```

这些使用安全默认值自动推导。

---

## 3.5 渐进式复杂度

默认：

```text
基础模式
```

需要精确控制的用户再展开：

```text
高级设置
```

---

# 4. 当前 Profile 的新定位

当前内置 Profile：

```text
explore
general
code-review
synthesize
```

继续保留在 Runtime。

但 UI 不直接暴露英文 Profile，而映射为角色类型：

| 用户看到 | Runtime Profile | 默认权限 |
|---|---|---|
| 分析 | `explore` | 只读 |
| 开发 | `general` | 可修改 |
| 代码审查 | `code-review` | 只读 |
| 汇总 | `synthesize` | 只读 |

Profile 应成为：

> **内部 Agent Preset，而不是普通用户必须理解的概念。**

---

# 5. 新页面信息架构

推荐：

```text
团队

[ 成员与职责 ] [ 运行情况 ]
```

## 成员与职责

负责：

```text
团队名称
成员
职责
权限
协作方式
团队预览
高级配置
```

## 运行情况

负责：

```text
运行中任务
排队任务
最近任务
等待批准
未读消息
成员状态
Token Usage
```

当前“配置 + Runtime 状态”混在一个长页面的结构应拆开。

---

# 6. 空状态

当前仅提示“尚未创建团队”不够。

推荐：

```text
团队

让多个 AI 成员长期负责当前项目中的不同工作。

┌───────────────────────────────┐
│ 还没有团队                    │
│                               │
│ 你希望这个团队主要做什么？     │
│                               │
│ [ 软件开发 ]   [ 代码审查 ]    │
│ [ 研究分析 ]   [ 自定义团队 ]  │
│                               │
│ ✨ 根据当前项目自动生成         │
└───────────────────────────────┘
```

用户第一步回答：

```text
我要一个什么团队？
```

而不是先填写 ID 和 Profile。

---

# 7. 团队模板

建议内置：

```text
软件开发团队
代码审查团队
研究分析团队
轻量开发团队
自定义团队
```

## 软件开发团队

```text
架构分析
理解需求、分析项目结构、制定方案
只读

开发
实现功能、修复 Bug、修改代码
可修改项目

代码审查
检查代码质量、风险与测试
只读
```

底层：

```text
架构分析 → explore
开发     → general
代码审查 → code-review
```

## 研究分析团队

```text
资料调研 → explore
代码分析 → explore
方案比较 → explore
结果汇总 → synthesize
```

---

# 8. AI 自动生成团队

建议提供：

```text
✨ 根据当前项目自动生成
```

流程：

```text
Workspace
   ↓
分析项目结构 / 技术栈
   ↓
生成 Team Proposal
   ↓
用户确认
```

例如识别到：

```text
TypeScript
Electron
Node.js
SQLite
Multi-Agent Runtime
```

可以推荐：

```text
架构师
Desktop 开发
Runtime 开发
代码审查
```

第一阶段可以只预留入口，后续实现自动生成。

> ⚠️ 修订说明：本节（对应 Phase 5）目前只有产品流程，缺少实现路径——例如是否需要额外调用模型分析 workspace、分析结果如何映射为 `TeamTemplate`、识别失败或结果不可靠时如何降级。这部分工作量容易被低估，建议单独做一次技术可行性评估后再排期，不与 P0/P1 打包估时。

---

# 9. 成员编辑页

当前十几个字段应缩减到四个主要字段：

```text
成员名称
主要职责
工作权限
是否允许分派任务
```

示例：

```text
成员名称
[ 后端开发 ]

主要职责
[ 负责实现后端功能、修复 Bug 和维护 Runtime。 ]

工作权限
○ 只能查看
● 可以修改项目

任务协作
☑ 可以把复杂任务分派给临时助手
```

---

# 10. ID 自动化

## Team ID

基础模式隐藏。

自动生成：

```text
team_<slug>
```

创建后保持稳定。

高级设置可查看。

## Member ID

同样基础模式隐藏。

自动生成：

```text
architect
developer
reviewer
```

或：

```text
member_01
member_02
```

ID 仍继续用于 Runtime 引用，但不是普通用户决策项。

---

# 11. Description 与 System Prompt

普通用户不应该同时理解：

```text
描述
System Prompt
```

基础模式统一为：

```text
主要职责
```

例如：

```text
负责分析架构和跨模块问题，提出实现方案。
```

Jojo 自动生成 System Prompt：

```text
你是当前项目的架构分析成员。

职责：
负责分析架构和跨模块问题，提出实现方案。

工作要求：
- 聚焦当前项目；
- 不执行职责之外的任务；
- 给出明确、可执行的结论；
- 遵守成员权限边界。
```

高级设置允许用户覆盖 System Prompt。

> ⚠️ 修订说明：自动生成的 System Prompt 质量直接决定基础模式能否覆盖大多数场景——如果生成的 Prompt 过于通用，用户会被迫频繁打开高级设置手动覆盖，违背本方案"减少必须理解的概念"的初衷。建议在 Phase 1 增加对生成 Prompt 效果的专项验证（对比人工撰写 Prompt 的任务完成质量），而不是只验证映射逻辑本身。

---

# 12. ReadOnly 改造

当前：

```text
只读成员
```

改为：

```text
工作权限

● 只能查看
  可以阅读、搜索和分析项目，不会修改文件。

○ 可以修改项目
  可以创建和修改项目文件并执行开发任务。
```

映射：

```text
只能查看
→ readOnly = true

可以修改项目
→ readOnly = false
```

Runtime 当前 Profile 的安全限制仍保留：

```ts
profile.readOnly || member.readOnly === true
```

---

# 13. Tool Allow / Deny 改造

基础模式完全隐藏：

```text
工具允许列表
工具拒绝列表
```

高级模式改成能力开关：

```text
文件
☑ 查看项目
☑ 搜索项目
☑ 修改项目

执行
☑ 执行命令

网络
☑ 搜索网页
☐ 使用浏览器

协作
☑ 分派子任务
```

再映射到底层 Tool Policy。

原则：

> 没有用户 override 时，不保存 `tools`，直接使用 Profile 默认策略。

---

# 14. Spawn 改造

当前：

```text
允许派生子智能体
允许派生的 Profile
最大活跃派生数
```

改成：

```text
复杂任务时

○ 自己完成

● 可以分派子任务给临时助手
```

帮助文案：

```text
遇到较大的任务时，该成员可以临时调用其他 AI 助手完成调研、审查等子任务。
```

`spawn.profiles` 在基础模式自动推导。

推荐：

```text
分析
→ explore, synthesize

开发
→ explore, code-review

审查
→ explore

汇总
→ none
```

`maxActive` 默认：

```text
2
```

高级设置才允许修改。

---

# 15. Provider / Model 改造

默认：

```text
模型
● 跟随当前项目
○ 指定模型
```

跟随项目时：

```ts
providerId = undefined;
model = undefined;
```

继续复用当前 Runtime 继承机制。

> ⚠️ 修订说明：实际推导逻辑（`packages/orchestration/src/team/effective-config.ts`）比文档最初给出的 `member.model ?? profile.model ?? input.model` 多一层判断——`profile.model` 存在但等于哨兵值 `'inherit'` 时会被跳过，继续取会话/项目级的 `input.model`：
>
> ```ts
> const providerId = member.providerId ?? input.providerId;
> const inheritedModel =
>   profile.model && profile.model !== 'inherit'
>     ? profile.model
>     : input.model;
> const model = member.model ?? inheritedModel;
> ```
>
> Mapping Layer 实现"跟随当前项目"时应直接对齐这段源码，而不是照抄本节最初的简化伪代码，否则在 Profile 显式声明 `model: 'inherit'` 的场景下会推导出错误的模型。

长期可扩展：

```text
● 自动
○ 更快
○ 更强
○ 更省
○ 指定模型
```

与 Model Metadata / Capability 系统联动。

---

# 16. Team Concurrency 改造

当前：

```text
最大并发任务数 [3]
```

改成：

```text
同时工作的成员

● 自动（推荐）
○ 自定义
```

Auto 第一阶段可以简单实现为：

```ts
Math.min(enabledMembers.length, 3)
```

或者继续使用默认值 3，只是不要求普通用户决策。

> ⚠️ 修订说明：`Math.min(enabledMembers.length, 3)` 是合理的起步启发式，但未区分不同 Profile 成员的资源消耗差异（例如会执行终端命令、修改文件的 `general` 成员，与只读的 `explore` 成员，实际占用的 Token/时间成本并不相同）。P0 阶段可以先用这个简单公式，但建议在 P1/P2 阶段结合实际运行数据（Token Usage、任务耗时）细化 Auto 策略，而不是长期停留在"数成员个数"这一层。

---

# 17. 成员卡片

不要默认展开完整表单。

建议：

```text
┌────────────────────────────────┐
│ 🧭 架构分析          已启用     │
│                                │
│ 理解项目架构并制定实现方案      │
│                                │
│ 只读 · 自动模型 · 可分派助手    │
│                                │
│                         编辑 > │
└────────────────────────────────┘
```

点击“编辑”再打开 Drawer / Modal。

这样整个 Team 页面更像“团队管理”，而不是配置文件编辑器。

---

# 18. 基础 / 高级模式

## 基础模式

```text
名称
职责
角色类型
权限
是否允许委派
模型：跟随项目
```

## 高级模式

```text
Member ID
Profile
Provider
Model
System Prompt
Tool Allow / Deny
Spawn Profiles
Spawn MaxActive
```

高级区提示：

```text
这些设置用于精确控制 Agent Runtime。
如果你不确定，请保留自动配置。
```

---

# 19. 团队效果预览

新增：

```text
团队工作方式
```

例如：

```text
        你
        │
        ▼
     架构分析
        │
    ┌───┴─────┐
    ▼         ▼
   开发      调研助手
    │
    ▼
 代码审查
```

同时用自然语言总结：

```text
3 名长期成员
1 名成员可以修改项目
2 名成员只读
最多同时运行 3 个任务
复杂任务可以分派临时助手
开发改动不会自动合并
```

这个预览比直接显示 `readOnly / spawn / maxActive` 更有价值。

---

# 20. 新建团队流程

建议最多 3 步。

## Step 1：选择用途

```text
你希望团队主要做什么？

[ 软件开发 ]
[ 代码审查 ]
[ 研究分析 ]
[ 自定义 ]
[ ✨ 根据项目生成 ]
```

## Step 2：确认成员

```text
架构分析
开发
代码审查

[ + 添加成员 ]
```

## Step 3：查看团队工作方式

展示：

```text
权限
并发
协作关系
可写成员
自动模型
```

最后：

```text
创建团队
```

---

# 21. Role Preset

建议新增前端语义层：

```ts
type TeamRolePresetId =
  | 'analysis'
  | 'development'
  | 'review'
  | 'synthesis'
  | 'custom';

type TeamRolePreset = {
  id: TeamRolePresetId;
  title: string;
  description: string;
  defaultProfile: SubAgentProfile;
  defaultReadOnly: boolean;
  defaultDelegation: boolean;
};
```

示例：

```ts
const ROLE_PRESETS = {
  analysis: {
    title: '分析',
    description: '理解项目、搜索信息并提出方案',
    defaultProfile: 'explore',
    defaultReadOnly: true,
    defaultDelegation: true
  },

  development: {
    title: '开发',
    description: '实现功能、修改代码并修复问题',
    defaultProfile: 'general',
    defaultReadOnly: false,
    defaultDelegation: true
  },

  review: {
    title: '代码审查',
    description: '检查 Bug、风险和测试覆盖',
    defaultProfile: 'code-review',
    defaultReadOnly: true,
    defaultDelegation: false
  },

  synthesis: {
    title: '汇总',
    description: '整理多个成员结果并形成结论',
    defaultProfile: 'synthesize',
    defaultReadOnly: true,
    defaultDelegation: false
  }
};
```

---

# 22. UI Draft

不要继续让 Runtime Schema 直接驱动 UI。

建议新增：

```ts
type SimpleTeamMemberDraft = {
  id: string;

  name: string;
  responsibility: string;

  role: TeamRolePresetId;

  access:
    | 'read'
    | 'write';

  delegation:
    | 'disabled'
    | 'auto';

  modelMode:
    | 'inherit'
    | 'custom';

  customModel?: string;

  advanced?: AdvancedTeamMemberDraft;
};
```

高级数据：

```ts
type AdvancedTeamMemberDraft = {
  profile?: SubAgentProfile;

  providerId?: string;
  model?: string;

  systemPrompt?: string;

  toolsAllow?: string[];
  toolsDeny?: string[];

  spawnProfiles?: SubAgentProfile[];
  spawnMaxActive?: number;
};
```

---

# 23. UI → Runtime Mapping

增加统一转换：

```ts
function buildTeamMemberDefinition(
  draft: SimpleTeamMemberDraft
): TeamMemberDefinition
```

流程：

```text
Role
 ↓
Profile

Access
 ↓
ReadOnly

Responsibility
 ↓
Description + Generated Prompt

Delegation
 ↓
Spawn Policy

Model Mode
 ↓
Provider / Model override

Advanced
 ↓
Explicit Runtime Override
```

---

# 24. Profile 推导

```ts
function resolveProfile(
  draft: SimpleTeamMemberDraft
): SubAgentProfile {
  return (
    draft.advanced?.profile
    ?? ROLE_PRESETS[draft.role].defaultProfile
  );
}
```

---

# 25. Prompt Builder

新增：

```text
prompt-builder.ts
```

例如：

```ts
buildMemberSystemPrompt({
  name,
  responsibility,
  role,
  access
});
```

不要将 Prompt 拼接逻辑放在 React 组件中。

---

# 26. Spawn 推导

```ts
const DEFAULT_SPAWN_PROFILES = {
  analysis: ['explore', 'synthesize'],
  development: ['explore', 'code-review'],
  review: ['explore'],
  synthesis: []
};
```

基础模式：

```ts
spawn =
  delegation === 'auto'
    ? {
        enabled: true,
        profiles: DEFAULT_SPAWN_PROFILES[role],
        maxActive: 2
      }
    : undefined;
```

> ⚠️ 修订说明：`DEFAULT_SPAWN_PROFILES` 的取值（例如"开发"默认允许委派 `explore` 和 `code-review`）是产品假设，没有真实使用数据支撑。建议在 P1 灰度阶段收集实际委派记录，验证这些默认路径是否符合真实使用习惯，再决定是否固化；如果默认值与实际委派行为偏差较大，用户会频繁跑去高级设置手动调整 `spawnProfiles`，削弱本方案"自动推导"的价值。

---

# 27. Team Template 数据结构

```ts
type TeamTemplate = {
  id: string;
  title: string;
  description: string;

  members: {
    name: string;
    responsibility: string;
    role: TeamRolePresetId;
    access: 'read' | 'write';
    delegation: 'disabled' | 'auto';
  }[];
};
```

软件开发模板：

```ts
const SOFTWARE_TEAM: TeamTemplate = {
  id: 'software-development',

  title: '软件开发',

  description:
    '适合功能开发、Bug 修复和代码审查。',

  members: [
    {
      name: '架构分析',
      responsibility:
        '理解需求、分析项目结构并制定实现方案。',
      role: 'analysis',
      access: 'read',
      delegation: 'auto'
    },

    {
      name: '开发',
      responsibility:
        '实现功能、修改代码并修复问题。',
      role: 'development',
      access: 'write',
      delegation: 'auto'
    },

    {
      name: '代码审查',
      responsibility:
        '检查改动中的 Bug、风险和缺失测试。',
      role: 'review',
      access: 'read',
      delegation: 'disabled'
    }
  ]
};
```

---

# 28. Legacy Team 兼容

新版必须能无损加载旧 Team。

如果旧成员使用：

```text
custom profile
custom tools
custom prompt
custom spawn
custom provider/model
```

不能强制覆盖成默认模板。

建议：

```text
能映射标准角色
→ 使用对应 Role Preset

无法安全映射
→ role = custom
```

并显示：

```text
高级配置已修改
```

保存时必须保留原有高级配置。

---

# 29. Profile Registry 长期优化

当前 Profile Registry 已支持：

```text
builtin
extension
user
project
```

但当前 Team UI 写死：

```ts
const PROFILES = [
  'explore',
  'general',
  'code-review',
  'synthesize'
];
```

长期应提供：

```ts
listAgentProfiles({ workspace })
```

让高级模式 Profile Picker 动态读取 Registry。

普通模式仍只展示 Role。

关键区分：

```text
Role
= UX 概念

Profile
= Runtime 概念
```

---

# 30. 页面组件化

不建议继续扩展当前单体：

```text
TeamSettings.tsx
```

推荐：

```text
apps/desktop/src/renderer/team/
  TeamSettingsPage.tsx
  TeamList.tsx
  TeamEditor.tsx
  TeamMemberCard.tsx
  TeamMemberEditor.tsx
  TeamCreateWizard.tsx
  TeamPreview.tsx
  TeamRuntimeView.tsx

  presets.ts
  draft.ts
  mappings.ts
  prompt-builder.ts
```

---

# 31. 各组件职责

## TeamSettingsPage

```text
Team selection
Tabs
Create entry
Global state
```

## TeamEditor

```text
团队名称
成员列表
工作方式
保存
```

## TeamMemberCard

```text
成员摘要
状态
权限
编辑入口
```

## TeamMemberEditor

```text
基础配置
高级配置
```

## TeamCreateWizard

```text
模板选择
成员确认
团队预览
```

## TeamRuntimeView

迁移当前：

```text
activeTasks
queuedTasks
recentTasks
unreadMessages
```

---

# 32. 后端改造范围

第一阶段不建议修改：

```text
TeamDefinitionSchema
TeamMemberDefinitionSchema
Team Runtime
Task Queue
Spawn Runtime
```

原因：

当前 Runtime 已经能表达新 UI 的需求。

第一阶段应采用：

```text
新 UX Semantic Layer
        ↓
Mapping Layer
        ↓
现有 TeamMemberDefinition
        ↓
现有 Persistent Team Runtime
```

这样回归范围最小。

---

# 33. 保存后的首次使用引导

创建 Team 后用户仍可能问：

> 怎么使用？

保存成功后建议显示：

```text
团队已创建

你可以直接试试：

[ 让团队分析当前项目 ]
[ 检查最近修改 ]
[ 找出潜在问题 ]
```

并给示例：

```text
“让开发团队检查这个项目并修复测试失败。”

“让架构师分析当前 Runtime 的设计问题。”
```

---

# 34. Runtime 页面优化

运行状态建议按：

```text
当前任务
等待中的任务
最近完成
```

展示。

每条任务：

```text
成员
任务摘要
状态
开始时间
模型
Token Usage
```

状态统一使用用户语义：

```text
空闲
工作中
排队
等待批准
已停用
异常
```

不要暴露 Lane 等内部概念。

---

# 35. 安全说明

对于可写成员，明确显示：

```text
可以修改项目
```

若实际使用隔离 Worktree：

```text
修改会在独立工作区中完成，不会自动合并到主分支。
```

这是用户比 `readOnly=false` 更关心的信息。

删除团队时建议说明：

```text
将删除：
• 团队配置
• 成员配置
• 历史任务
• 团队消息

不会删除项目文件。
```

---

# 36. 开发阶段

## Phase 1：UX Semantic Layer

实现：

```text
Role Preset
Team Template
Simple Draft
Mapping
Prompt Builder
```

Runtime 不变。

---

## Phase 2：页面重构

实现：

```text
Member Card
Member Editor
Advanced 折叠
配置 / Runtime Tab
Team Preview
Concurrency Auto
```

---

## Phase 3：动态 Profile

新增：

```text
Profile Registry Desktop API
```

高级 Profile Picker 不再写死。

---

## Phase 4：Model Capability 联动

结合模型元数据系统实现：

```text
自动
更快
更强
更省
指定模型
```

---

## Phase 5：AI 生成团队

实现：

```text
✨ 根据当前项目生成团队
```

---

# 37. 优先级

## P0

必须做：

- 隐藏 Team ID；
- 隐藏 Member ID；
- 隐藏 Profile；
- 隐藏 Tool Allow / Deny；
- Spawn 改成“分派子任务”；
- Provider / Model 默认继承；
- Simple Member Editor；
- Advanced 折叠。

## P1

强烈建议：

- Team Templates；
- Role Presets；
- 配置 / 运行分 Tab；
- Team Preview；
- Concurrency Auto；
- Member Card。

## P2

后续：

- AI 自动生成团队；
- 动态 Profile Registry；
- Model 自动路由；
- Capability Preset。

---

# 38. 测试方案

## Role Mapping

验证：

```text
analysis     -> explore
development  -> general
review       -> code-review
synthesis    -> synthesize
```

## Draft Mapping

验证：

```text
Simple Draft
 ↓
TeamMemberDefinition
```

包括：

```text
readOnly
spawn
provider inherit
model inherit
systemPrompt
tools override
```

## Legacy Config

已有：

```text
custom tools
custom prompt
custom spawn
custom model
```

新版打开、编辑、保存后不得丢失。

## Runtime Regression

保证：

```text
Team Runtime
Sub-Agent Spawn
Tool Policy
Provider inheritance
Model inheritance
Member Toggle
Task Queue
```

行为不变。

## UI

覆盖：

```text
模板创建
添加成员
修改角色
只读 / 可写切换
开启 / 关闭委派
高级设置
模型继承
删除成员
保存团队
切换 Runtime Tab
```

---

# 39. UX 验收标准

首次使用 Team 的用户，即使完全不理解：

```text
Profile
Tool Name
Spawn
Provider inheritance
```

仍然能创建一个可运行团队。

正常创建流程中，用户不需要填写：

```text
ID
Profile
Provider
Model
System Prompt
Tool Allow
Tool Deny
Spawn Profile
Spawn MaxActive
```

即可完成 Team 配置。

---

# 40. 技术验收标准

- [ ] 原 `TeamDefinitionSchema` 可继续使用；
- [ ] 原 `TeamMemberDefinitionSchema` 可继续使用；
- [ ] Persistent Team Runtime 无需大改；
- [ ] Role UI 可以稳定映射到 Profile；
- [ ] Advanced Override 不丢失；
- [ ] Provider / Model 保持继承逻辑；
- [ ] Tool Policy 默认由 Profile 决定；
- [ ] ReadOnly 最终安全约束不弱化；
- [ ] Spawn 仍受 Runtime 并发约束；
- [ ] Legacy Team 可以无损打开和保存；
- [ ] 配置页不再直接要求普通用户理解 Runtime 内部术语。

---

# 41. 最终推荐结构

```text
用户
 │
 │ 定义
 ▼
角色 / 职责 / 权限
 │
 ▼
Role Preset
 │
 ▼
UX Mapping Layer
 │
 ├─ Profile
 ├─ ReadOnly
 ├─ System Prompt
 ├─ Tool Policy
 ├─ Spawn Policy
 ├─ Provider
 └─ Model
 │
 ▼
TeamMemberDefinition
 │
 ▼
现有 Persistent Team Runtime
```

---

# 42. 最终结论

Jojo 当前 Team 的核心 Runtime 能力已经足够。

真正需要优化的是：

```text
用户语义层
```

当前设计：

```text
用户
 ↓
Runtime Schema
```

目标设计：

```text
用户
 ↓
角色 / 职责 / 权限
 ↓
Jojo 自动配置 Runtime
```

因此本次优化不应该以“增加更多配置项”为目标，而应该以：

> **减少用户必须理解的概念数量**

为核心。

最终产品原则建议固定为：

> **用户定义职责，Jojo 配置能力。**
