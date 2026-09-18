# Jojo Agent 浏览器设置页优化方案

> 项目：`zxt6991-source/jojo-agent`  
> 分析基线：`main` 分支，2026-09-17  
> 目标：降低“浏览器设置”页的理解成本，同时保留现有安全边界、Recording 能力和高级调试能力。

---

## 1. 结论先行

当前浏览器设置页的问题，不是“控件太多”这么简单，而是把 **6 种不同的用户任务** 放在了同一个页面：

1. 是否允许 Jojo 使用浏览器；
2. 使用沙箱浏览器还是本机浏览器；
3. 浏览器操作的安全审批规则；
4. 哪些网站可以免去首次导航确认；
5. Browser Recording 的资产管理；
6. Recording Studio 的编辑、调试、Heal、Revision 管理。

这六类任务面向的用户、使用频率和风险完全不同。

其中前 2～4 项属于“设置”，第 5 项属于“自动化资产管理”，第 6 项实际上已经接近“开发工具 / 调试器”。

**建议不要继续在当前页面做折叠优化，而是重新划分信息架构：**

- 浏览器设置页只保留：**启用状态 + 浏览器模式 + 网站访问权限摘要**；
- “始终允许的域名”改成二级管理入口；
- `Recording Registry` 从设置页移出，变成独立的“浏览器自动化”管理页；
- `Recording Studio` 从设置页完全移出，只从某个 Recording 的详情进入；
- JSON、Replay debugger、Heal diff、Revision history 默认只在“开发者工具”中显示。

最终目标是让普通用户第一次进入浏览器设置时，只需要理解两个问题：

> **要不要让 Jojo 操作网页？**  
> **需要登录网页时，用哪种浏览器？**

---

# 2. 当前实现分析

## 2.1 当前浏览器配置本身其实很简单

当前 `BrowserSettingsSchema` 只有以下配置：

```ts
{
  enabled: boolean,
  allowedDomains: string[],
  mode: 'sandbox' | 'chrome',
  chromeDebugPort: number,
  chromeNewTab: boolean
}
```

默认值为：

```ts
{
  enabled: true,
  allowedDomains: [],
  mode: 'sandbox',
  chromeDebugPort: 9222,
  chromeNewTab: true
}
```

也就是说，真正需要普通用户决策的实际上只有：

- 是否启用；
- 浏览器模式；
- 是否维护站点白名单。

`chromeDebugPort` 和 `chromeNewTab` 当前也没有必要暴露给普通用户，应继续作为内部配置存在。

---

## 2.2 当前页面实际承担了过多职责

当前 `BrowserSettingsPage` 直接写在：

```text
apps/desktop/src/renderer/main.tsx
```

页面中同时包含：

- 浏览器总开关；
- 当前状态 Badge；
- 三栏浏览器安全策略说明；
- Sandbox / Chrome 模式选择；
- 域名白名单编辑器；
- Recording Registry；
- User / Project Recording 路径；
- Recording 信任 / 撤销信任；
- Recording 删除 / 复制；
- Recording JSON Editor；
- Step Timeline；
- Replay Debugger；
- Heal Diff；
- Revision History。

这已经不是“设置页”，而是：

```text
设置页
+ 权限说明页
+ Recording 管理器
+ Recording IDE
+ 调试器
```

页面天然会变得很长，而且用户无法快速判断哪些内容是“必须设置的”，哪些内容只是高级功能。

---

# 3. 主要 UX 问题

## 3.1 首屏把安全实现细节暴露给普通用户

当前首页直接展示：

- 自动允许哪些操作；
- 哪些操作每次批准；
- Cookie metadata；
- Cookie value；
- script；
- hover；
- recording replay；
- tab switch。

这些信息本身没有错，但它们属于**权限机制解释**，而不是浏览器基础设置。

普通用户真正需要知道的是：

> Jojo 不会无条件点击、输入或下载，敏感操作仍然会询问我。

不需要在首次进入页面时学习浏览器工具的完整权限矩阵。

### 建议

把当前三块：

```text
自动允许
每次批准
不走浏览器
```

压缩为一条安全摘要：

```text
安全保护
Jojo 可以自动读取和浏览已允许的网站。
输入、提交、下载、脚本执行和敏感数据访问仍会请求确认。

[查看详细权限规则]
```

“查看详细权限规则”跳转到 Permissions，或者打开二级说明。

浏览器设置页不应该再复制一套 Permission Governance 的心智模型。

---

## 3.2 “始终允许的域名”命名容易造成误解

当前功能实际上只是：

> 允许站点首次导航 / 新建页面时免去批准。

但是标题叫：

```text
始终允许的域名
```

用户非常容易理解成：

> 这个网站上的所有浏览器操作都会自动允许。

而实际代码中：

- click；
- hover；
- eval；
- type；
- press；
- upload；
- download；
- Cookie value；

仍然可能需要审批。

### 建议改名

将：

```text
始终允许的域名
```

改为：

```text
无需确认即可打开的网站
```

辅助说明：

```text
这些网站可以直接打开。
输入、提交、下载等敏感操作仍会单独询问。
```

这样语义会准确很多。

---

## 3.3 “本机浏览器”容易让用户误以为复用日常 Chrome 登录态

当前实现会启动带独立：

```text
--user-data-dir=<jojo profile>
```

的浏览器实例。

因此它更准确的语义是：

> Jojo 专用的本机 Chrome/Chromium 窗口。

它不是简单附着到用户正在使用的日常 Chrome Profile。

### 当前文案

```text
本机浏览器
自动打开 Chrome 窗口，登录一次后可继续使用。
```

已经部分表达了这个行为，但仍然容易误解。

### 建议文案

```text
本机浏览器
适合需要登录的网站。

Jojo 会打开一个独立的 Chrome 窗口。
第一次需要在这个窗口登录，之后可以继续使用登录状态。
不会读取你日常 Chrome 的登录状态。
```

这样还能顺带强化隐私感知。

---

## 3.4 Recording Registry 不属于设置

当前页面包含完整的：

```text
Recording Registry
User / Project 路径
source
trust
revision
highRisk
domains
effects
override
```

这是典型的“资源管理”模型，而不是设置模型。

它相当于把：

> VS Code 的 Extension 管理器

塞进：

> Settings → Browser

里。

用户只是想切换浏览器模式，却突然需要理解：

- User Recording；
- Project Recording；
- Override；
- Exact Version Trust；
- Revision；
- Content Hash。

这就是当前页面最大的认知断层。

---

## 3.5 Recording Studio 更不应该出现在 Settings

当前 Studio 提供：

```text
Recording editor
Step Timeline
Replay debugger
Heal diff
Revision history
```

并且直接允许编辑 Recording JSON。

这已经是完整的开发者工具。

### 问题

普通用户进入设置页时看到：

```text
revision
content hash
selector heal
run id
step id
JSON schema
```

会立即产生两个疑问：

1. “我是不是必须懂这些才能用浏览器？”
2. “我是不是配置错了什么？”

即便用户完全不需要 Recording，这些内容仍然占据页面。

### 建议

彻底从 Settings 页面移除。

---

# 4. 新的信息架构

推荐将浏览器相关能力拆成三层。

```text
设置
└── 浏览器
    ├── 基础设置
    │   ├── 启用浏览器
    │   ├── 浏览器模式
    │   └── 网站访问
    │
    └── 浏览器自动化
        └── [管理录制任务]

浏览器自动化
├── Recording 列表
├── Recording 详情
└── 开发者工具
    ├── JSON
    ├── Replay
    ├── Heal
    └── Revision
```

核心原则：

> **配置和资产分离，资产和调试分离。**

---

# 5. 新浏览器设置页

## 5.1 建议页面

```text
┌─────────────────────────────────────────────┐
│ 浏览器                              已开启   │
│ 让 Jojo 打开和操作需要交互的网页。          │
│                                             │
│ ┌─────────────────────────────────────────┐ │
│ │ 浏览器访问                         [●] │ │
│ │ Jojo 可以在需要时打开并操作网页。      │ │
│ └─────────────────────────────────────────┘ │
│                                             │
│ 使用哪种浏览器？                            │
│                                             │
│ ┌──────────────────┐ ┌──────────────────┐   │
│ │ ● 沙箱浏览器     │ │ ○ 本机浏览器     │   │
│ │ 推荐             │ │ 需要登录时使用   │   │
│ │                  │ │                  │   │
│ │ 与本机浏览器隔离 │ │ 独立 Chrome 窗口 │   │
│ └──────────────────┘ └──────────────────┘   │
│                                             │
│ 网站访问                                    │
│ 未信任的网站首次打开时会询问。              │
│ 已允许 3 个网站                [管理网站 >] │
│                                             │
│ 安全保护                                    │
│ 输入、提交、下载等操作仍会询问。            │
│                             [查看权限规则]   │
│                                             │
│ 浏览器自动化                                │
│ 已保存 7 个录制任务             [管理 >]    │
│                                             │
│                  [保存修改]                 │
└─────────────────────────────────────────────┘
```

首屏只让用户做两个真正重要的决定：

```text
浏览器是否启用？
沙箱还是本机浏览器？
```

---

# 6. 浏览器模式重新表达

建议继续保留当前 Runtime 中：

```text
sandbox
chrome
```

两个枚举，不需要为了 UI 优化修改 Contract。

## Sandbox

当前：

```text
沙箱浏览器
嵌在主窗口右侧栏，Cookie 不与本机浏览器共享。
```

建议：

```text
沙箱浏览器 · 推荐

适合查资料、测试网页和访问不熟悉的网站。
与电脑上的日常浏览器隔离。
```

让用户先理解“用途”，再理解“技术差异”。

---

## Chrome

建议：

```text
本机浏览器

适合需要登录的网站。
Jojo 会打开一个独立的 Chrome 窗口，
登录一次后可继续使用。
```

点击“了解区别”后再展示：

```text
沙箱浏览器：
- 在 Jojo 内显示
- Cookie 与本机隔离
- 默认推荐

本机浏览器：
- 打开独立 Chrome 窗口
- 登录状态可持续保存
- 适合后台系统、管理后台等登录页面
```

---

# 7. 网站白名单改成二级页面 / Drawer

主页面不再直接显示 Chip 输入器。

只显示：

```text
网站访问

未加入列表的网站首次打开时会请求确认。

3 个网站无需确认即可打开

[管理网站]
```

点击后：

```text
无需确认即可打开的网站

这些网站可以直接打开。
输入、提交、上传、下载等操作仍会单独询问。

[ github.com                       × ]
[ *.githubusercontent.com          × ]
[ internal.example.com             × ]

[ 添加网站                                  ]

只填写域名，例如：
example.com
*.example.com
```

这样既保留当前能力，也避免它抢占主页面。

---

# 8. Recording 重新定位为“浏览器自动化”

用户并不关心：

```text
Recording Registry
```

这个内部名称。

更友好的产品名称：

```text
浏览器自动化
```

Recording 可在内部继续作为技术名称使用。

---

## 8.1 Recording 列表页

推荐：

```text
浏览器自动化

把重复网页操作保存下来，之后可以再次运行。

[ + 新建录制 ]

──────────────────────────────────────

登录后台并导出报表
项目
12 步
example.com
包含输入和下载操作

[打开]

──────────────────────────────────────

查看 GitHub Issue
个人
5 步
github.com
只读操作

[打开]
```

不应默认显示：

```text
recording id
revision
content hash
effects
override source
filesystem path
```

这些放到详情页中的“技术信息”。

---

## 8.2 Project / User Scope

当前存在：

```text
user
project
builtin
```

UI 建议改成：

```text
个人
项目
内置
```

并在 Tooltip 中说明。

### 个人

```text
只保存在你的电脑上，可在所有项目中使用。
```

### 项目

```text
跟随当前项目，可由项目内容提供。
首次使用或内容变化后可能需要重新信任。
```

用户不需要首先理解：

```text
~/.jojo/browser-recordings
<workspace>/.jojo/browser-recordings
```

路径可以放在：

```text
⋯ → 在文件夹中显示
```

---

# 9. Recording Trust 重新表达

目前用户需要理解：

```text
project recording
trusted
exact version
high risk
revision
```

推荐转成更直接的风险提示：

```text
此自动化来自当前项目

它包含：
✓ 打开网页
✓ 点击
! 输入内容
! 下载文件

运行前需要信任此版本。

[查看步骤]
[信任并允许使用]
```

当项目 Recording 发生修改：

```text
此自动化自上次信任后发生了变化

[查看变化]
[重新信任]
```

不要把：

```text
content hash
revision
```

作为用户的主要决策依据。

它们应该继续存在于底层信任模型中，但用户看到的是：

> 内容变了，所以需要重新确认。

---

# 10. Recording Studio 重新设计

当前 Studio 五个 Tab：

```text
Recording editor
Step Timeline
Replay debugger
Heal diff
Revision history
```

建议分成普通视图和开发者视图。

## 默认 Recording 详情

```text
概览
步骤
运行记录
```

### 概览

展示：

- 名称；
- 描述；
- 来源；
- 网站；
- 参数；
- 输出；
- 是否包含敏感操作；
- 最近运行状态。

### 步骤

使用可读列表：

```text
1. 打开 example.com/login
2. 在“用户名”中输入 {{username}}
3. 点击“登录”
4. 等待页面加载
5. 点击“导出”
6. 等待文件下载
```

优先展示：

```text
动作 + 人类可理解目标
```

而不是：

```text
selector
fingerprint
stepId
frame path
```

---

## 开发者工具

放在：

```text
⋯ → 开发者工具
```

里面再提供：

```text
原始 JSON
Replay Debugger
Selector Heal
Revision History
```

只有真正排查 Recording 的用户才进入这里。

---

# 11. 统一中文产品语言

当前页面存在较多中英文混排：

```text
Recording Registry
User
Project
steps
revision
Domains
Effects
Recording editor
Step Timeline
Replay debugger
Heal diff
Revision history
```

建议 UI 统一为：

| 当前 | 建议 |
|---|---|
| Recording Registry | 浏览器自动化 |
| Recording | 录制任务 / 自动化 |
| User | 个人 |
| Project | 项目 |
| steps | 步骤 |
| revision | 版本 |
| Domains | 网站 |
| Effects | 操作类型 |
| Recording editor | 编辑 |
| Step Timeline | 步骤 |
| Replay debugger | 运行记录 / 回放调试 |
| Heal diff | 选择器修复 |
| Revision history | 版本历史 |

开发者视图仍可以保留英文技术字段。

---

# 12. 设置页保存交互

当前浏览器设置始终显示：

```text
保存浏览器设置
```

建议和当前 Memory 页保持一致：

```text
所有设置已保存。
```

发生变化后：

```text
有尚未保存的修改。

[放弃修改] [保存]
```

这样用户能明确知道：

- 当前改动有没有保存；
- 是否需要操作。

---

# 13. 推荐的组件拆分

当前 `BrowserSettingsPage` 直接位于：

```text
apps/desktop/src/renderer/main.tsx
```

建议首先把它从 `main.tsx` 中拆出去。

推荐结构：

```text
apps/desktop/src/renderer/browser/
├── BrowserSettingsPage.tsx
├── BrowserModeSelector.tsx
├── BrowserSiteAccess.tsx
├── BrowserSecuritySummary.tsx
├── BrowserAutomationEntry.tsx
│
├── recordings/
│   ├── BrowserRecordingsPage.tsx
│   ├── BrowserRecordingCard.tsx
│   ├── BrowserRecordingDetail.tsx
│   ├── BrowserRecordingSteps.tsx
│   └── BrowserRecordingTrust.tsx
│
└── developer/
    ├── BrowserRecordingDeveloperTools.tsx
    ├── BrowserRecordingJsonEditor.tsx
    ├── BrowserReplayDebugger.tsx
    ├── BrowserHealDiff.tsx
    └── BrowserRevisionHistory.tsx
```

现有：

```text
apps/desktop/src/renderer/browser-settings.ts
```

继续负责：

```text
parseBrowserDomainList
browserDomainIssue
```

也可以后续改成：

```text
browser/browser-settings-model.ts
```

---

# 14. P0：不改 Runtime 就能完成的优化

这一阶段风险最低。

## 保持不变

继续使用当前：

```ts
BrowserSettingsSchema
```

不修改：

```text
enabled
allowedDomains
mode
chromeDebugPort
chromeNewTab
```

也不修改 Recording Contract。

## 只调整 Renderer

完成：

1. 把 `BrowserSettingsPage` 从 `main.tsx` 抽离；
2. 删除首页三栏 Permission 细节；
3. 首页只显示安全摘要；
4. 白名单变成二级 Drawer；
5. Recording Registry 从基础设置区域移走；
6. Studio 从设置页移走；
7. Recording UI 全部中文化；
8. 加入“未保存 / 已保存”状态；
9. 修正“本机浏览器”的解释；
10. 保持原有 Permission Governance 完全不变。

### 预计收益

普通用户首屏信息量可以从目前的：

```text
20+ 个概念
```

降低到：

```text
4 个概念

浏览器
沙箱
本机浏览器
网站访问
```

---

# 15. P1：增加运行状态感知

在 P0 完成后，可以继续提升体验。

例如模式卡显示：

```text
本机浏览器
已检测到 Google Chrome
```

或者：

```text
本机浏览器
未检测到可用浏览器

[查看解决方法]
```

而不是等真正执行任务时才报错。

如果检测到 Edge / Chromium，也应该显示实际检测结果，而不是统一写 Chrome。

---

# 16. P2：自动推荐浏览器模式

未来可以增加一个 UI 层的推荐逻辑，但不建议第一版就修改 Runtime 枚举。

例如用户选择：

```text
默认使用沙箱浏览器
```

当 Agent 发现：

```text
需要登录
```

时，在对话中提示：

```text
这个网站需要登录。

[改用本机浏览器]
```

而不是要求用户提前进入 Settings 修改模式。

长期甚至可以演进成：

```text
浏览器模式

● 自动选择（推荐）
○ 始终使用沙箱
○ 始终使用本机浏览器
```

但这需要明确的 Runtime 行为设计，建议后续独立实现。

---

# 17. 推荐最终结构

浏览器设置页：

```text
浏览器

[浏览器访问开关]

使用哪种浏览器？
[沙箱浏览器 · 推荐]
[本机浏览器 · 需要登录]

网站访问
3 个网站无需确认即可打开
[管理]

安全保护
敏感操作仍会询问
[查看权限规则]

浏览器自动化
7 个录制任务
[管理]
```

浏览器自动化：

```text
浏览器自动化

[搜索]
[+ 新建]

个人
- 自动化 A
- 自动化 B

当前项目
- 自动化 C
- 自动化 D
```

Recording 详情：

```text
自动化 C

[概览] [步骤] [运行记录]

来源：项目
网站：example.com
12 个步骤
包含：输入 / 下载

[信任此版本]

⋯
  复制
  删除
  在文件夹中显示
  开发者工具
```

开发者工具：

```text
[JSON]
[Replay Debugger]
[Selector Heal]
[Revision History]
```

这样不同层级的用户会自然停留在不同深度。

---

# 18. 建议优先级

| 优先级 | 改动 | 价值 | 风险 |
|---|---|---:|---:|
| P0 | Recording / Studio 移出浏览器基础设置 | 极高 | 低 |
| P0 | 权限规则压缩为安全摘要 | 极高 | 低 |
| P0 | 白名单改成二级管理 | 高 | 低 |
| P0 | 浏览器模式文案重写 | 高 | 极低 |
| P0 | UI 全中文化 | 高 | 极低 |
| P0 | BrowserSettingsPage 从 main.tsx 拆组件 | 高 | 低 |
| P0 | 未保存状态提示 | 中 | 低 |
| P1 | Chrome / Chromium 可用性检测 | 中 | 中 |
| P1 | Recording 可读步骤视图 | 高 | 中 |
| P2 | 自动模式 / 动态切换 | 高 | 高 |

---

# 19. 验收标准

优化后建议至少满足：

### 普通用户

第一次进入页面后 10 秒内能够回答：

```text
浏览器当前是否开启？
现在使用哪种浏览器？
如果网站需要登录应该选哪个？
```

而不需要理解：

```text
Recording
revision
content hash
selector
heal
effects
```

### 页面信息量

浏览器首页：

- 一级操作不超过 5 个；
- 默认不出现 JSON；
- 默认不出现文件系统路径；
- 默认不出现 revision/hash；
- 默认不出现完整 Permission Matrix；
- 默认不出现 Replay / Heal 调试能力。

### 功能完整性

优化不应削弱：

- Domain Allowlist；
- Sandbox；
- Local Chrome；
- Project Recording Trust；
- Recording 编辑；
- Replay；
- Heal；
- Revision；
- Permission Governance。

只是改变它们在产品中的层级。

---

# 20. 推荐实施顺序

建议按照以下顺序改造：

```text
Step 1
BrowserSettingsPage 从 main.tsx 抽离

Step 2
重做基础设置页：
Enable + Mode + Site Access + Security Summary

Step 3
把 Recording Registry 抽成独立页面

Step 4
把 Recording Studio 抽成独立详情页

Step 5
默认 Recording 详情改成可读步骤视图

Step 6
JSON / Heal / Revision 下沉到开发者工具

Step 7
统一中文术语和安全提示

Step 8
补 Renderer Test / E2E
```

这样每一步都可以单独提交和回归，避免一次大改导致 Browser Runtime 行为变化。

---

# 21. 最终建议

这次优化的关键不是：

> 把当前页面做得更漂亮。

而是重新回答：

> **用户进入“浏览器设置”究竟是为了完成什么任务？**

普通用户进入这里通常只有三个原因：

1. 打开 / 关闭浏览器能力；
2. 需要登录网站，所以切换浏览器模式；
3. 处理某个网站的访问确认。

Recording、Revision、Replay、Heal 都是重要能力，但它们应该在需要时逐层出现。

因此推荐将浏览器产品结构从当前：

```text
一个超级设置页
```

重构为：

```text
简单的浏览器设置
        ↓
浏览器自动化资产
        ↓
Recording 开发与调试工具
```

这会比单纯使用 Accordion、折叠卡片或减少文字更有效地降低用户心智负担，同时基本不需要修改现有 Browser Runtime 和安全模型。
