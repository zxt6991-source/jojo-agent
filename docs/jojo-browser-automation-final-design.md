# Jojo Agent Browser Automation 最终优化设计

> 文档状态：Final Draft  
> 适用项目：`zxt6991-source/jojo-agent`  
> 参考项目：`open-octo/octo-agent`、`earendil-works/pi`  
> 目标：将 Jojo 当前 Browser 能力从 Electron 内部工具升级为独立、可复用、可录制、可确定性回放、可受约束自愈、可被 Workflow/Headless Runtime 调用的 Browser Automation Runtime。

---

## 1. 背景与结论

Jojo 当前 `main` 已经具备较完整的 Browser MVP，而不是从零开始：

- Electron Sandbox Browser；
- Chrome CDP attach；
- 多 Page / Tab；
- `open / back / reload`；
- `click / hover / type / press / select`；
- `upload / download`；
- `screenshot`；
- Accessibility Tree 读取；
- `eval`；
- Console / Network / Page Error 诊断；
- Cookies；
- Element Ref；
- Element Fingerprint；
- selector 漂移后的候选评分重定位；
- `record_start / record_stop / replay`；
- YAML Recording；
- Recording 参数化；
- Secret 参数；
- Replay Retry。

因此后续工作的重点不是“再做一个 Browser Tool”，而是完成以下升级：

1. **从 Electron Main 中解耦 Browser Automation 核心；**
2. **将 Recording 从 Agent Trace 扩展为 User Demo Recording；**
3. **将 Recording 升级为稳定的 Browser Automation DSL；**
4. **建立确定性恢复 + 受约束 LLM Self-Heal；**
5. **让 Recording 成为 Workflow 的一级执行原语；**
6. **为未来 CLI / Server / Scheduler / IM / Headless Runtime 保留 Browser Backend 扩展能力。**

最终建议：

> **Octo 提供 Browser Recording / Replay / Auto Wait / Self-Heal 的产品与执行模型；Pi 提供 Ports / Operations / Extension / Lifecycle / Tool Progress 的架构方法；Jojo 保留自身 Permission、Fingerprint、Revision、Workflow DAG、Utility Model 和 Electron + Chrome 双 Backend 的优势。**

---

# 2. 设计目标

## 2.1 核心目标

Browser Automation V2 应满足：

### G1. Runtime 独立

Browser Automation 核心不得依赖 Electron。

```text
Agent / Workflow
      |
      v
Browser Automation Runtime
      |
      v
Browser Driver Port
      |
  +---+------------------+
  |                      |
Chrome CDP         Electron Adapter
```

### G2. 双录制模型

同时支持：

```text
Agent Trace Recording
Agent 调 Browser Tool
        |
        v
保存成功执行步骤
```

以及：

```text
User Demo Recording
用户亲自操作浏览器
        |
        v
DOM/CDP 捕获
        |
        v
Recording Compiler
```

### G3. 确定性优先

Replay 正常路径不调用 LLM：

```text
Recording
   |
   v
Deterministic Replay
   |
   +--> Selector
   +--> Fingerprint relocation
   +--> Wait
   +--> Verify
   +--> Retry
```

只有确定性恢复失败后才进入 Self-Heal。

### G4. 可编排

Browser Recording 必须能直接作为 Workflow Step：

```text
Workflow
  |
  +--> Agent Step
  +--> Tool Step
  +--> Recording Step
  +--> Foreach
  +--> Condition
```

### G5. 安全优先

Browser Automation 是有外部副作用的能力，必须具备：

- Domain Policy；
- Permission Gate；
- Secret Out-of-Band；
- Upload Workspace Boundary；
- Download Boundary；
- Self-Heal 行为约束；
- Recording Revision Control；
- 高风险动作审批。

---

# 3. 非目标

Browser Automation V2 第一阶段明确不做：

- 不将整个 Browser Engine 改成 Playwright；
- 不把 Recording 变成任意脚本执行器；
- 不允许 Self-Heal 修改任务语义；
- 不允许 Healer 任意执行 JS；
- 不使用 LLM 作为每一步 selector 解析器；
- 不把 Recording 和 Skill 合并；
- 不把 Browser Runtime 绑定到 Desktop UI；
- 不在第一阶段实现完整 RPA 可视化编辑器。

---

# 4. 借鉴原则

## 4.1 借鉴 Octo 的内容

优先借鉴：

- User Demo Recording；
- DOM Capture；
- 自动 Wait；
- Download 捕获；
- New Tab 跟随；
- Recording 参数化；
- Output / Bind；
- Verify；
- End URL；
- Fingerprint / Anchors；
- Deterministic Replay；
- Self-Heal；
- Self-Heal 成功后持久化修复；
- Recording -> Workflow。

不直接照搬：

- Go 包组织；
- Ruby Workflow DSL；
- Octo 的单体 Browser API；
- 任何会破坏 Jojo 现有 Permission / Revision / Workflow 架构的实现。

## 4.2 借鉴 Pi 的内容

Pi 对 Jojo Browser 最重要的价值不是 Browser 代码，而是架构理念：

### Ports / Operations

```text
Tool
 |
 v
Operations Interface
 |
 +--> Local
 +--> Remote
 +--> Alternative backend
```

Browser 应变成：

```text
Browser Tool
    |
    v
BrowserAutomationPort
    |
    v
BrowserDriver
```

### Lifecycle

长生命周期资源按 Session 生命周期管理：

```text
SessionStart
   |
   +--> 不立即启动 Browser

First Browser Call
   |
   +--> lazy create BrowserSession

Session Shutdown
   |
   +--> detach debugger
   +--> close page
   +--> remove listener
   +--> cleanup temp download
   +--> clear secret cache
```

### Progress

Replay 应通过 Tool Progress 持续输出：

```text
1/12 open login
2/12 fill username
3/12 fill password
4/12 click login
waiting for network...
selector relocated by fingerprint
...
```

而不是最后一次性返回大段文本。

---

# 5. 当前 Jojo 的主要架构问题

当前 Browser 实现核心集中在：

```text
apps/desktop/src/main/browser-runtime.ts
```

其职责已经同时覆盖：

- Browser State；
- Electron View；
- Chrome CDP；
- Browser Actions；
- Security；
- Recording；
- Replay；
- Secret；
- Diagnostics；
- Download；
- Dock UI；
- Page 管理。

继续在该文件中增加：

```text
User Recorder
Compiler
Verify
Outputs
Self-Heal
Workflow Adapter
Headless Host
```

会导致 Browser 成为难以测试、难以复用、难以脱离 Electron 的“大类”。

因此 **Browser V2 的第一件事必须是拆包，而不是继续加功能。**

---

# 6. 最终包结构

建议新增：

```text
packages/
  browser-automation/
    src/
      index.ts

      runtime/
        browser-automation-runtime.ts
        browser-session-manager.ts

      ports/
        browser-driver.ts
        browser-healing-port.ts
        browser-recording-store.ts
        browser-permission-port.ts

      actions/
        browser-actions.ts
        action-runner.ts

      targets/
        browser-target.ts
        fingerprint.ts
        candidate-scoring.ts
        target-resolver.ts

      recorder/
        recorder.ts
        raw-event.ts
        recorder-compiler.ts
        recorder-compression.ts
        auto-wait.ts
        parameterizer.ts

      recording/
        schema.ts
        migrate.ts
        serializer.ts
        registry.ts
        revision.ts

      replay/
        replay-engine.ts
        replay-step-runner.ts
        replay-context.ts
        replay-result.ts
        recovery.ts
        verify.ts

      healing/
        healer.ts
        page-digest.ts
        heal-policy.ts
        heal-writeback.ts

      diagnostics/
        console.ts
        network.ts
        page-errors.ts

      tools/
        browser-tool.ts
        recording-tools.ts

  browser-cdp/
    src/
      index.ts
      driver.ts
      session.ts
      page.ts
      cdp-client.ts
      cdp-socket.ts
      chrome-launcher.ts
      recorder-binding.ts
      download-controller.ts
      oopif.ts

apps/desktop/src/main/
  browser/
    electron-browser-driver.ts
    browser-dock-host.ts
    browser-secret-prompt.ts
    browser-runtime-adapter.ts
```

---

# 7. 依赖规则

必须明确依赖方向：

```text
contracts
   ^
   |
browser-automation
   ^
   |
browser-cdp

apps/desktop
   |
   +--> browser-automation
   +--> browser-cdp
   +--> electron adapter
```

## 7.1 强制规则

`packages/browser-automation` 禁止：

```ts
import { BrowserWindow } from 'electron';
import { WebContentsView } from 'electron';
import { WebContents } from 'electron';
```

Browser Automation Core 只能依赖抽象 Port。

---

# 8. Browser Driver Port

建议核心接口：

```ts
export interface BrowserDriver {
  openSession(
    options: BrowserSessionOptions,
    signal: AbortSignal
  ): Promise<BrowserSession>;
}

export interface BrowserSession {
  listPages(): Promise<BrowserPageInfo[]>;

  newPage(url?: string): Promise<BrowserPage>;
  selectPage(pageId: string): Promise<void>;
  closePage(pageId: string): Promise<void>;

  activePage(): Promise<BrowserPage>;

  subscribe(
    listener: BrowserSessionEventListener
  ): () => void;

  close(): Promise<void>;
}

export interface BrowserPage {
  navigate(url: string): Promise<void>;

  read(options?: BrowserReadOptions): Promise<BrowserSnapshot>;

  resolveTarget(
    target: BrowserTarget,
    options?: ResolveTargetOptions
  ): Promise<ResolvedBrowserTarget>;

  click(target: ResolvedBrowserTarget): Promise<void>;
  hover(target: ResolvedBrowserTarget): Promise<void>;
  type(target: ResolvedBrowserTarget, text: string): Promise<void>;
  press(target: ResolvedBrowserTarget, key: string): Promise<void>;
  select(target: ResolvedBrowserTarget, values: string[]): Promise<void>;

  wait(condition: BrowserWaitCondition): Promise<void>;

  screenshot(options?: BrowserScreenshotOptions): Promise<BrowserImage>;

  getUrl(): Promise<string>;
  getTitle(): Promise<string>;
}
```

重点不是方法名，而是：

> Recorder、Replay、Healing、Workflow 不知道底层是 Chrome 还是 Electron。

---

# 9. Browser Target V2

当前 Jojo 已有 Fingerprint 候选评分机制，应继续保留并增强。

建议：

```ts
export interface BrowserTarget {
  selector?: string;
  fingerprint?: BrowserFingerprint;
  frame?: BrowserFramePath;
}

export interface BrowserFingerprint {
  primarySelector?: string;
  alternateSelectors?: string[];

  tag: string;
  role?: string;
  accessibleName?: string;

  id?: string;
  testId?: string;
  fieldName?: string;
  inputType?: string;
  placeholder?: string;
  href?: string;

  neighborText?: string;
}
```

## 9.1 解析顺序

```text
1. primary selector
2. alternate selectors
3. semantic candidate search
4. fingerprint candidate scoring
5. ambiguity check
6. deterministic failure
```

### 禁止行为

当出现：

```text
Best Score = 82
Second Score = 80
```

不允许直接点击 Best Candidate。

必须返回：

```text
browser_target_ambiguous
```

再进入恢复 / Self-Heal。

---

# 10. Browser Recording 双模式

## 10.1 Agent Trace Recording

保留现有能力：

```text
Agent Browser Action
       |
       v
Action Success
       |
       v
Compile Action
       |
       v
Recording Step
```

适合：

- Agent 已经成功完成一次任务；
- 用户希望将当前成功流程保存为可复用 Automation；
- 快速生成 Recording。

建议正式命名：

```text
recordMode: agent_trace
```

## 10.2 User Demo Recording

新增：

```text
record_start(mode=user_demo)
       |
       v
用户获得页面控制权
       |
       v
DOM Capture Listener
       |
       v
Runtime.addBinding
       |
       v
RawBrowserEvent
       |
       v
Compiler
       |
       v
Recording V2
```

适合：

- 登录业务系统；
- ERP 操作；
- 内部后台；
- 复杂表单；
- 无 API 的业务系统；
- 用户能操作但 Agent 不容易首次探索的流程。

---

# 11. User Demo Recorder 设计

## 11.1 捕获事件

第一阶段支持：

```ts
type RawBrowserEventType =
  | 'navigate'
  | 'click'
  | 'change'
  | 'key'
  | 'select'
  | 'upload'
  | 'download'
  | 'wait';
```

事件结构：

```ts
export interface RawBrowserEvent {
  id: string;
  timestamp: number;
  type: RawBrowserEventType;

  pageId: string;
  url: string;

  frame?: BrowserFramePath;
  selector?: string;
  fingerprint?: BrowserFingerprint;

  value?: string;
  key?: string;

  secret?: boolean;

  wait?: RawWaitHint;

  download?: {
    suggestedFilename?: string;
  };
}
```

## 11.2 CDP 注入

Chrome Backend 使用：

```text
Runtime.addBinding
Page.addScriptToEvaluateOnNewDocument
Runtime.bindingCalled
```

注入 Capture Script 捕获：

- `click`；
- `change`；
- `keydown`；
- `submit`；
- SPA navigation；
- input field metadata；
- stable selector；
- alternate selector；
- accessibility metadata。

## 11.3 OOPIF

Browser V2 不应假定页面只有主 Frame。

最终需支持：

```text
Top Page
  |
  +--> same-origin iframe
  |
  +--> cross-origin iframe / OOPIF
```

Recording Step 保存：

```yaml
frame:
  selectors:
    - iframe[name="payment"]
```

---

# 12. Auto Wait

这是 Browser V2 的 P0 能力。

## 12.1 为什么需要

真实网页操作通常是：

```text
click
 |
 +--> fetch/xhr
 +--> loading
 +--> mutation
 +--> modal
 +--> page transition
```

简单录制：

```text
click A
click B
```

Replay 会发生竞态。

## 12.2 自动捕获

User Demo Recorder 在用户动作后观察：

- fetch / XHR；
- DOM Mutation；
- modal / dialog / overlay；
- navigation；
- download；
- new tab。

Compiler 自动插入：

```yaml
- action: click
  target: ...

- action: wait
  condition:
    type: network_idle
  timeoutMs: 15000
```

或者：

```yaml
- action: wait
  condition:
    type: element_visible
    target: ...
```

---

# 13. Recording Compiler

Recorder 不允许直接把 Raw Event 写成最终 YAML。

流程：

```text
RawBrowserTrace
      |
      v
Normalize
      |
      v
Deterministic Compression
      |
      v
Auto Wait
      |
      v
Parameterize
      |
      v
Infer Verify / Output
      |
      v
Recording V2
      |
      v
Optional LLM Refiner
```

## 13.1 Deterministic Compression

必须在 LLM 之前执行。

包括：

### 连续输入合并

```text
input: a
input: ab
input: abc
```

压缩为：

```text
input: abc
```

### Select 修正

```text
select A
select B
```

只保留最终 B。

### 重复点击去重

同一元素抖动产生重复 click 时，仅保留有效 click。

### 无意义 Detour

可确定证明的：

```text
A -> B -> A
```

可压缩为最终有效路径。

注意：只有“可确定证明冗余”的事件才能删除。

---

# 14. LLM Refiner 的严格边界

可选 LLM Refiner 仅允许：

- 生成 Recording Description；
- 优化 Step Label；
- 重命名 Params；
- 为非 Secret 参数生成描述；
- 删除被 Raw Trace 明确证明无效的 detour；
- 生成更好的说明文本。

禁止：

- 新建原始 Trace 不存在的 click target；
- 发明 selector；
- 发明额外导航；
- 发明 `eval`；
- 修改 Secret；
- 添加原始动作中不存在的外部副作用。

最终编译器必须验证：

```text
Final Recording Step
        |
        v
Trace Provenance Check
```

未能映射回 Raw Trace 的 Target 一律拒绝。

---

# 15. Recording V2 DSL

建议将现有 `version: 1` 升级为 V2。

## 15.1 示例

```yaml
version: 2

id: export-monthly-report
name: Export Monthly Report

description: Login and export a monthly report.

scope: user

domains:
  - example.com

params:
  - name: username
    type: string
    required: true

  - name: password
    type: string
    secret: true
    required: true

  - name: month
    type: string
    required: true

outputs:
  - name: report
    type: file

start:
  url: https://example.com/login

end:
  urlContains: /reports

steps:
  - id: username
    action: type
    target:
      selector: '#username'
      fingerprint:
        tag: input
        role: textbox
        accessibleName: Username
        fieldName: username
    value: '{{username}}'
    verify:
      valueNotEmpty: true

  - id: password
    action: type
    target:
      selector: '#password'
      fingerprint:
        tag: input
        inputType: password
    value: '{{password}}'

  - id: login
    action: click
    target:
      selector: 'button[type="submit"]'
      fingerprint:
        tag: button
        role: button
        accessibleName: Login
    wait:
      networkIdle: true
    verify:
      urlContains: /dashboard

  - id: export
    action: download
    target:
      selector: '#export-report'
      fingerprint:
        tag: button
        accessibleName: Export
    bind: report
```

---

# 16. Recording V2 Schema 建议

```ts
interface BrowserRecordingV2 {
  version: 2;

  id: string;
  name: string;
  description?: string;

  scope?: 'user' | 'project';

  domains?: string[];

  params: BrowserRecordingParam[];
  outputs: BrowserRecordingOutput[];

  start?: BrowserRecordingStart;
  end?: BrowserVerify;

  steps: BrowserRecordingStepV2[];

  revision: number;
  contentHash: string;

  createdAt: string;
  updatedAt: string;
}
```

Step：

```ts
interface BrowserRecordingStepV2 {
  id: string;

  action:
    | 'navigate'
    | 'click'
    | 'hover'
    | 'type'
    | 'press'
    | 'select'
    | 'upload'
    | 'download'
    | 'wait'
    | 'extract';

  target?: BrowserTarget;

  url?: string;
  value?: string;
  values?: string[];
  key?: string;

  wait?: BrowserWaitPolicy;
  verify?: BrowserVerify;

  bind?: string;

  timeoutMs?: number;
}
```

---

# 17. Verify Engine

Replay 成功不能只定义为：

```text
CDP command 没报错
```

必须支持：

```ts
interface BrowserVerify {
  urlContains?: string;
  urlMatches?: string;

  exists?: BrowserTarget;
  notExists?: BrowserTarget;

  textContains?: string;

  valueEquals?: string;
  valueNotEmpty?: boolean;

  downloadCompleted?: boolean;
}
```

## 17.1 Step Verify

例如：

```yaml
verify:
  urlContains: /dashboard
```

## 17.2 Recording End Verify

例如：

```yaml
end:
  urlContains: /reports
```

用于避免：

```text
关键 click 实际无效
   |
   +--> command success
   |
   +--> Recording 错误报告成功
```

---

# 18. Output / Bind

Recording 不应只是：

```text
成功 / 失败
```

它应产出结构化结果：

```ts
interface BrowserReplayResult {
  recordingId: string;
  success: boolean;

  steps: BrowserReplayStepResult[];

  outputs: Record<string, BrowserOutputValue>;

  finalUrl?: string;

  relocated: boolean;
  selfHealed: boolean;

  healRecords?: BrowserHealRecord[];
}
```

例如：

```json
{
  "recordingId": "export-report",
  "success": true,
  "outputs": {
    "report": {
      "type": "file",
      "path": "/tmp/report.xlsx"
    }
  }
}
```

这样才能直接交给 Workflow 后续 Step。

---

# 19. Replay Engine V2

建议状态：

```text
LOADING
   |
   v
VALIDATING
   |
   v
PREPARING
   |
   v
RUNNING_STEP
   |
   +--> RESOLVING_TARGET
   +--> EXECUTING
   +--> WAITING
   +--> VERIFYING
   |
   +--> RECOVERY
   |      |
   |      +--> deterministic retry
   |      +--> relocation
   |      +--> retype
   |      +--> overlay recovery
   |      +--> follow new tab
   |
   +--> HEALING
   |
   v
FINAL_VERIFY
   |
   v
COMPLETED / FAILED
```

---

# 20. 三层恢复策略

禁止一失败就让 LLM 接管。

必须分三层。

## Layer 1：Target Relocation

```text
Primary Selector
      |
      x
      |
Alternate Selector
      |
      x
      |
Candidate Scan
      |
Fingerprint Score
```

如果唯一高分候选：

```text
relocated = true
```

直接继续。

## Layer 2：Deterministic Recovery

包括：

- 等待元素重新出现；
- 等待 Network Idle；
- 清空输入框后重新 type；
- 页面打开新 Tab 后自动切换；
- 页面短暂 Overlay 消失后 retry；
- stale target refresh；
- 页面 reload 后重新 resolve；
- click 后无预期 network 时有限 retry。

所有策略：

- 有明确上限；
- 有明确 timeout；
- 不改变任务语义。

## Layer 3：LLM Self-Heal

只有 Layer 1 / 2 失败才执行。

---

# 21. Self-Heal 架构

## 21.1 Browser Engine 必须保持 LLM-Free

定义 Port：

```ts
export interface BrowserHealingPort {
  heal(
    request: BrowserHealRequest,
    signal: AbortSignal
  ): Promise<BrowserHealProposal>;
}
```

`browser-automation` 只依赖 Port，不依赖 Provider。

Utility Model Adapter 位于更高层：

```text
browser-automation
       |
       v
BrowserHealingPort
       ^
       |
agent-runtime / desktop host
       |
       v
Utility Model
```

Jojo 已有 Utility Model 设置，Browser Self-Heal 可直接复用。

---

# 22. Browser Page Digest

Self-Heal 第一阶段不要直接把整页 Screenshot 给模型。

构建：

```text
Interactable DOM Digest
```

例如：

```text
URL: https://example.com/settings

1
selector: button[data-testid="save"]
tag: button
role: button
name: Save Changes

2
selector: button.secondary
tag: button
role: button
name: Cancel

3
selector: input[name="email"]
tag: input
role: textbox
name: Email
```

Healer Request：

```json
{
  "action": "click",
  "failedSelector": "#save-button",
  "fingerprint": {
    "tag": "button",
    "role": "button",
    "accessibleName": "Save"
  },
  "candidates": []
}
```

允许返回：

```json
{
  "selector": "button[data-testid='save']",
  "confidence": 0.94,
  "reason": "same semantic save button"
}
```

---

# 23. Self-Heal 安全边界

Healer 只允许修改：

```text
Target Selector
```

可选扩展：

```text
Target Fingerprint
```

禁止修改：

- Action Type；
- URL；
- Param Value；
- Secret；
- Output；
- Download Path；
- JS；
- Workflow；
- Domain。

也就是说：

> Self-Heal 只能修复“在哪里执行原动作”，不能修改“原动作是什么”。

---

# 24. Self-Heal 持久化

Heal Proposal 不能一生成就写入 Recording。

流程必须是：

```text
Heal Proposal
      |
      v
Retry Step
      |
      v
Step Verify Success
      |
      v
Recording Revision Check
      |
      v
Atomic Write
```

失败的 Heal Proposal 不允许持久化。

---

# 25. Recording Revision / 并发控制

建议复用 Jojo Memory 已经验证过的思想：

```text
revision
contentHash
expectedHash
atomic write
recovery
```

Recording V2：

```yaml
revision: 7
contentHash: sha256:xxxx
```

Self-Heal 写回时：

```ts
updateRecording({
  id,
  expectedRevision: 7,
  expectedHash,
  patch
})
```

如果用户在 replay 同时手动修改 YAML：

```text
expectedHash mismatch
```

返回：

```text
recording_revision_conflict
```

不覆盖用户内容。

---

# 26. Secret 设计

Secret 必须继续走 Out-of-Band。

## 26.1 Secret 来源

建议：

```text
1. session secret cache
2. environment
3. encrypted local credential adapter（未来）
4. masked desktop prompt
```

Secret 不允许来自 Agent Tool Args。

## 26.2 Recorder 自动检测

遇到：

```html
<input type="password">
```

Raw Trace 中：

```text
secret = true
value = undefined
```

Compiler 自动生成：

```yaml
params:
  - name: password
    secret: true
```

必须保证密码不进入：

- Raw Trace；
- YAML；
- Agent Context；
- Memory；
- Logs；
- Diagnostics。

---

# 27. Recording Registry

Recording 应成为独立 Resource，而不是只保存在 Electron `userData` 内。

建议目录：

```text
~/.jojo/browser-recordings/
```

用户级。

项目级：

```text
<workspace>/.jojo/browser-recordings/
```

优先级：

```text
builtin
  < user
  < project
```

同 ID：Project 覆盖 User。

## 27.1 Project Trust

Project Recording 属于可执行资源，应进入 Project Trust 模型。

未信任项目：

```text
.jojo/browser-recordings
```

可读取元数据，但不能执行高风险步骤。

---

# 28. Recording 与 Skill 的边界

必须明确：

## Skill

告诉模型：

> “应该怎么做”。

## Browser Recording

告诉 Runtime：

> “按这套确定性步骤执行”。

## Workflow

告诉 Orchestrator：

> “Agent / Tool / Recording 之间怎么组合”。

结构：

```text
Skill
  |
  v
Agent Understands Task

Recording
  |
  v
Deterministic Browser Execution

Workflow
  |
  +--> Recording
  +--> Agent
  +--> Tool
  +--> Condition
  +--> Foreach
```

Recording 不要实现成 Skill。

---

# 29. Workflow Recording Step

新增一级 Schema：

```ts
export const WorkflowRecordingStepSchema =
  WorkflowStepBaseSchema.extend({
    type: z.literal('recording'),

    recording: BrowserRecordingIdSchema,

    params: WorkflowRecordingParamsSchema.default({}),
    inputs: WorkflowStepInputsSchema.optional(),

    retry: WorkflowRetryPolicySchema.optional(),

    outputSchema: z.record(z.string(), z.unknown()).optional()
  });
```

示例：

```yaml
name: monthly-report

inputs:
  month:
    type: string
    required: true

steps:
  - id: export
    type: recording
    recording: export-monthly-report
    params:
      month:
        valueFrom: $workflow.args.month

  - id: analyze
    type: agent
    dependsOn:
      - export
    profile: general
    task: |
      Analyze the file from export.outputs.report.
```

---

# 30. Workflow Output Handoff

Browser Recording 输出：

```text
steps.export.outputs.report
```

Workflow Reference 建议增加：

```text
$steps.export.outputs.report
```

最终实现：

```text
Browser Recording
      |
      v
report.xlsx
      |
      v
Agent Step
      |
      v
summary.md
```

这对通用 Agent 比单纯 Browser Tool 更重要。

---

# 31. Tool Progress

Browser Replay 必须使用现有：

```ts
ToolContext.onProgress
```

建议事件：

```ts
type BrowserReplayProgress =
  | { type: 'step_start'; index: number; total: number; label: string }
  | { type: 'step_wait'; reason: string }
  | { type: 'relocated'; oldSelector?: string; newSelector?: string }
  | { type: 'recovery'; strategy: string }
  | { type: 'heal_start'; round: number }
  | { type: 'heal_success'; selector: string }
  | { type: 'download'; path: string }
  | { type: 'step_success'; index: number }
  | { type: 'step_failed'; index: number; error: string };
```

Desktop UI 可渲染：

```text
✓ 1/8 Open login
✓ 2/8 Fill username
✓ 3/8 Fill password
→ 4/8 Login
  Waiting for network idle
✓ 4/8 Login
⚠ 5/8 Selector changed
  Relocated by fingerprint
✓ 5/8 Reports
↓ report.xlsx
```

---

# 32. Permission 模型

Browser Action 按风险分类。

## Read Only

例如：

- `read`；
- `pages`；
- Console 读取；
- Network 读取；
- Error 读取；
- Screenshot；
- Cookie metadata，不含值。

## Navigation

例如：

- open；
- back；
- reload；
- select page。

## Interaction

例如：

- click；
- hover；
- type；
- press；
- select。

## External Side Effect

例如：

- submit；
- upload；
- download；
- delete-like button；
- purchase；
- publish；
- message send。

## Dangerous / Restricted

例如：

- credential disclosure；
- arbitrary eval；
- cross-domain action；
- hidden destructive control。

Recording Replay 的权限不是：

```text
approve replay once = approve everything forever
```

而是 Recording 必须提前计算 Effect Summary：

```text
Domains:
- example.com

Effects:
- type credentials
- click login
- download report
```

用户审批的是本次完整 Automation Plan。

---

# 33. Domain 安全

Recording 必须显式记录：

```yaml
domains:
  - example.com
```

Replay 期间如果出现：

```text
example.com
   |
redirect
   |
evil.example.net
```

不允许自动继续。

返回：

```text
browser_domain_violation
```

除非目标域已在 Recording 或本次 Approval 中明确允许。

---

# 34. Eval 安全

`eval` 不应进入标准 Recording V2 的默认 Action 集合。

原因：

- 任意 JS 难以审计；
- 难以迁移；
- 容易读取敏感信息；
- Self-Heal 无法安全约束；
- Workflow 执行风险高。

建议：

```text
Direct Browser Tool
  eval = 保留

Recording DSL
  eval = 默认禁止
```

未来确需支持时另做：

```text
trustedScript
```

并配套 Hash / Trust / Permission。

---

# 35. Browser Session 生命周期

建议：

```text
Session created
    |
    +--> no browser

First browser call
    |
    v
BrowserSessionManager.acquire(sessionId)
    |
    v
lazy create driver session

Subsequent calls
    |
    +--> reuse

Session delete/shutdown
    |
    v
close pages
unsubscribe listeners
detach CDP
cleanup temporary downloads
clear secret cache
```

不建议 Browser Process / Debugger 在应用启动时全局常驻。

---

# 36. Chrome / Electron Backend

## 36.1 Chrome CDP

作为主要 Automation Backend：

优点：

- 用户真实登录态；
- 独立于 Electron View；
- 未来 Headless Runtime 可复用；
- Recorder 能使用 CDP Binding；
- 更容易实现 OOPIF；
- 可支持 Server / CLI。

## 36.2 Electron Sandbox

继续保留，用于：

- 隔离 Browser；
- Jojo Desktop 内嵌体验；
- 未登录网页；
- 高隔离探索。

## 36.3 不建议

不要把 Electron Sandbox 作为 Browser Automation Core 唯一实现。

---

# 37. Headless Runtime 预留

Browser V2 拆包完成后应能自然支持：

```text
jojo desktop
  |
Electron Browser Driver
```

以及：

```text
jojo run
  |
Chrome CDP Driver
```

未来：

```text
jojo serve
  |
Browser Session Pool
```

Browser 核心不应因 UI 模式变化而修改。

---

# 38. Error Code 设计

建议统一错误码：

```text
browser_session_open_failed
browser_page_not_found
browser_navigation_blocked
browser_domain_violation
browser_target_not_found
browser_target_ambiguous
browser_target_relocation_failed
browser_action_failed
browser_wait_timeout
browser_verify_failed
browser_download_failed
browser_upload_denied
browser_recording_not_found
browser_recording_invalid
browser_recording_revision_conflict
browser_replay_failed
browser_recovery_exhausted
browser_heal_unavailable
browser_heal_failed
browser_heal_rejected
browser_secret_missing
browser_permission_denied
```

Workflow 再映射成：

```text
workflow_step_failed
```

但保留 Browser 原始 Error Code。

---

# 39. Replay 幂等性

Browser Action 默认应视为：

```text
replay: never
```

因为 Agent Runtime 崩溃后不能安全假定：

```text
click submit
```

没有产生外部效果。

Recording Step 也一样。

只有明确声明 Observation / Read-only 的 Step 才可：

```text
replay: safe
```

Browser Journal 应保存：

```text
step_started
step_effect_dispatched
step_verified
```

Crash Resume 时：

```text
verified
  -> continue

effect_dispatched but not verified
  -> require explicit recovery / user confirmation
```

不能盲目再次点击。

---

# 40. Browser Recording Journal

长 Automation 建议写运行 Journal：

```json
{
  "runId": "brun_xxx",
  "recording": "export-report",
  "revision": 7,
  "step": "login",
  "state": "verified",
  "timestamp": "..."
}
```

用途：

- UI Timeline；
- 故障诊断；
- Crash 恢复；
- Self-Heal 审计；
- Workflow Journal 整合。

---

# 41. Observability

每次 Replay 建议记录：

```text
recording id
recording revision
page URL
step index
step id
action
selector
resolved selector
relocation score
retry count
recovery strategy
heal round
verify result
duration
download output
```

Secret / typed sensitive value 必须脱敏。

---

# 42. UI 最小需求

第一阶段不需要完整可视化 RPA 编辑器。

只需：

## Recording List

```text
Name
Scope
Steps
Params
Outputs
Last Updated
Status
```

## Recording Detail

```text
Run Plan
Parameters
Outputs
Domains
Revision
```

## Recording 操作

```text
Replay
Rename
Delete
Open YAML
Duplicate
```

## Replay Progress

实时显示当前 Step / Recovery / Self-Heal。

---

# 43. Browser Recording Test Site

强烈建议新增内部 E2E fixture：

```text
apps/browser-test-site/
```

或：

```text
packages/browser-e2e-fixtures/
```

包含：

- Login；
- SPA Fetch；
- Dynamic ID；
- Class Churn；
- Modal；
- New Tab；
- File Upload；
- File Download；
- iframe；
- OOPIF；
- Delayed Hydration；
- Selector Drift；
- Duplicate Labels；
- Redirect；
- Validation Error。

Browser Automation 没有可控 Test Site 时，很难长期稳定迭代。

---

# 44. 测试分层

## Unit Test

重点：

```text
fingerprint scoring
selector ranking
recording migration
parameterization
secret stripping
compiler compression
wait insertion
verify
revision conflict
heal policy
```

## Driver Integration

Chrome 本地：

```text
navigate
click
type
select
upload
download
new tab
iframe
```

## Recording E2E

```text
User Demo
   -> compile
   -> save
   -> replay
   -> verify
```

## Drift E2E

录制后修改测试页面：

```text
id 改变
class 改变
DOM 顺序改变
label 轻微改变
```

验证：

```text
fingerprint relocation
```

## Self-Heal E2E

强制 selector 失效：

```text
Layer 1 fail
Layer 2 fail
LLM Heal
verify success
writeback
next replay no LLM
```

---

# 45. 性能限制

建议默认值：

```text
max recording steps: 200
max replay duration: 10 min
max per-step timeout: 30 sec
max deterministic retries: 2
max heal rounds: 2
max digest candidates: 200
max digest chars: 32 KB
max outputs: 32
max params: 64
```

允许配置，但必须有硬上限。

---

# 46. Migration：现有 Recording V1 -> V2

现有 V1：

```yaml
version: 1
params: []
steps: []
```

迁移原则：

- 保留原 steps；
- `fingerprint` 转换为 `target.fingerprint`；
- selector 转换为 `target.selector`；
- 自动生成 step id；
- outputs 为空；
- verify 为空；
- revision 初始化为 1；
- contentHash 重新计算。

示例：

```ts
migrateBrowserRecording(raw): BrowserRecordingV2
```

V1 必须继续可读，避免直接破坏用户 Recording。

---

# 47. 对当前 BrowserRuntime 的迁移策略

不要一次性重写。

## Stage A

抽出纯逻辑：

```text
browser-recording-store
browser-recording-params
browser-security
fingerprint scoring
```

迁移到 `browser-automation`。

## Stage B

定义：

```text
BrowserDriver
BrowserSession
BrowserPage
```

当前 BrowserRuntime 通过 Adapter 使用旧实现。

## Stage C

Chrome CDP 迁移到：

```text
packages/browser-cdp
```

## Stage D

Replay Engine 从 BrowserRuntime 中拆出。

## Stage E

Electron View / Dock 留在 Desktop。

最后：

```text
browser-runtime.ts
```

只保留 Desktop 组装逻辑，目标控制在较小规模。

---

# 48. 开发阶段

## B1：Browser Core 拆包

**优先级：P0**

内容：

- 新增 `packages/browser-automation`；
- 定义 Browser Driver Ports；
- 拆出 Security / Fingerprint / Recording Store；
- Desktop 使用 Adapter；
- 行为保持不变。

验收：

- Browser MVP 功能无回归；
- `browser-automation` 无 Electron import；
- 单元测试全部迁移通过。

---

## B2：Recording V2

**优先级：P0**

内容：

- V2 Schema；
- Target；
- Verify；
- Output；
- Bind；
- End Verify；
- Revision；
- V1 Migration。

验收：

- V1 Recording 可自动读取；
- V2 可 round-trip YAML；
- Revision / Hash 正常。

---

## B3：User Demo Recorder

**优先级：P0**

内容：

- CDP Binding；
- DOM Capture；
- click/change/key/select；
- navigation；
- password detection；
- fingerprint capture。

验收：

用户手动完成 Login Demo 后，可以生成可读 Recording V2。

---

## B4：Auto Wait / Download / Tab

**优先级：P0**

内容：

- Network Wait；
- DOM Wait；
- Modal Wait；
- Download capture；
- New Tab capture；
- deterministic compression。

验收：

SPA / Download / 新标签页 Recording 可稳定 Replay。

---

## B5：Replay Engine V2

**优先级：P0**

内容：

- Step Runner；
- Verify；
- Output；
- Progress；
- Structured Result；
- Replay Journal。

验收：

Browser Recording 可作为独立 deterministic runtime 执行。

---

## B6：Deterministic Recovery

**优先级：P0**

内容：

- Fingerprint Relocation；
- retype；
- new tab following；
- wait/retry；
- overlay recovery；
- ambiguity handling。

验收：

测试页改变 CSS Class / ID 后，多数 Recording 不依赖 LLM 即可继续执行。

---

## B7：Utility Model Self-Heal

**优先级：P1**

内容：

- BrowserHealingPort；
- DOM Digest；
- Utility Model Adapter；
- constrained selector proposal；
- retry + verify；
- revision-safe writeback。

验收：

Selector 完全失效时：

```text
LLM Heal -> Verify -> Persist -> Next Replay no Heal
```

---

## B8：Workflow Recording Step

**优先级：P1**

内容：

- Workflow Recording Step；
- Params Binding；
- Output Binding；
- Retry；
- Journal；
- Timeline。

验收：

```text
Browser download
 -> Agent analyze
 -> Workflow complete
```

可完整执行。

---

## B9：Recording Registry

**优先级：P1**

内容：

- User recordings；
- Project recordings；
- override；
- trust；
- Desktop 管理 UI。

---

## B10：iframe / OOPIF 完整支持

**优先级：P1**

内容：

- frame path；
- same-origin frame；
- OOPIF session；
- recorder instrumentation；
- replay routing。

---

## B11：Headless Browser Host

**优先级：P2**

内容：

- 不依赖 Electron 的 Chrome runtime；
- 为 `jojo run / jojo serve / Scheduler` 准备。

---

## B12：Browser Automation UI

**优先级：P2**

内容：

- Recording editor；
- Step Timeline；
- Replay debugger；
- Heal diff；
- Revision history。

---

# 49. 推荐实施顺序

```text
B1 Core split
 |
 v
B2 Recording V2
 |
 v
B3 User Demo Recorder
 |
 v
B4 Auto Wait / Download / Tab
 |
 v
B5 Replay Engine V2
 |
 v
B6 Deterministic Recovery
 |
 +----------------+
 |                |
 v                v
B7 Self-Heal     B8 Workflow
 |                |
 +--------+-------+
          |
          v
B9 Registry
 |
 v
B10 OOPIF
 |
 v
B11 Headless
 |
 v
B12 Visual UI
```

---

# 50. 第一阶段不建议做的事情

不要在 B1–B6 阶段：

- 引入 Playwright 重写 CDP；
- 引入 Selenium；
- 做完整 RPA Visual Builder；
- 做 OCR Browser Control；
- 默认让 Vision Model 操作网页；
- 默认每 Step 请求 LLM；
- 将 Browser Recording 塞进 Skill；
- 将 Self-Heal 权限扩大成 Agent Browser 接管；
- 将 Browser Runtime 继续扩大为 Electron Main 大类。

这些都会干扰当前最重要的架构收敛。

---

# 51. 最终架构

```text
                         Agent Runtime
                              |
                              v
                         Browser Tool
                              |
                   +----------+----------+
                   |                     |
                   v                     v
             Direct Browser       Recording Replay
                   |                     |
                   |             +-------+--------+
                   |             |                |
                   |             v                v
                   |      Deterministic       Self-Heal
                   |         Engine               |
                   |             |          Utility Model
                   |             |                |
                   +-------------+----------------+
                                 |
                                 v
                       Browser Automation Core
                                 |
                                 v
                         BrowserSession Port
                                 |
                     +-----------+-----------+
                     |                       |
                     v                       v
                Chrome CDP             Electron Adapter
                     |                       |
                     v                       v
                  Chrome                WebContentsView


                         Workflow Runtime
                              |
                              v
                       Recording Step
                              |
                              +------> Browser Automation


                             Recorder
                     +----------+----------+
                     |                     |
                     v                     v
              Agent Trace              User Demo
                     |                     |
                     +----------+----------+
                                |
                                v
                        Recording Compiler
                                |
                                v
                         Recording V2 YAML
```

---

# 52. 最终设计原则

Browser Automation 后续开发必须持续遵守以下原则：

1. **Core 不依赖 Electron。**
2. **Deterministic First，LLM Last。**
3. **Selector 失败不能变成盲点。**
4. **Ambiguous Target 必须失败，不能猜。**
5. **Self-Heal 只修 Target，不改任务。**
6. **Heal 必须 Verify 后才能持久化。**
7. **Secret 永远不进入模型上下文。**
8. **Recording 是 Automation，不是 Skill。**
9. **Recording 必须可作为 Workflow 一级原语。**
10. **Browser 有副作用，Crash 后不能默认安全重放。**
11. **User / Project Recording 必须进入 Trust 模型。**
12. **所有执行必须支持 Abort / Timeout / Progress。**
13. **Browser Backend 可替换，Agent Contract 保持稳定。**
14. **Recording 文件可读、可 diff、可版本化。**
15. **当前已有 Fingerprint / Permission / Secret 能力应演进，不推倒重做。**

---

# 53. 最终推荐

Jojo Browser 当前已经跨过“能不能控制浏览器”的阶段。

下一阶段真正需要解决的是：

```text
Browser Tool
    -> Browser Automation Runtime
```

以及：

```text
一次性网页操作
    -> 可复用 Automation Asset
```

最终 Browser 应成为和 Memory、Workflow、Hooks、Sub-Agent 同级的基础能力：

```text
Jojo Agent Platform

├── Agent Runtime
├── Memory
├── Hooks
├── Sub-Agent
├── Workflow
├── Skills
├── MCP
└── Browser Automation
      ├── Direct Control
      ├── User Demo Recording
      ├── Agent Trace Recording
      ├── Recording DSL
      ├── Deterministic Replay
      ├── Recovery
      ├── Self-Heal
      └── Workflow Integration
```

其中最关键的开发顺序是：

> **先拆 `browser-runtime.ts`，再做 Recording V2，再做 User Demo Recorder；不要先做 Self-Heal。**

因为只有 Browser Core、Recording Contract 和 Replay Engine 稳定之后，Self-Heal 才有清晰、安全、可测试的边界。

---

# 54. 参考项目

- Jojo Agent: https://github.com/zxt6991-source/jojo-agent
- Octo Agent: https://github.com/open-octo/octo-agent
- Pi: https://github.com/earendil-works/pi

建议持续重点跟踪：

```text
Octo:
- browser recorder
- recording replay
- fingerprint / anchors
- self-heal
- browser workflow integration

Pi:
- extension architecture
- operations abstraction
- session lifecycle
- tool progress
- project trust
- runtime / UI separation
```

