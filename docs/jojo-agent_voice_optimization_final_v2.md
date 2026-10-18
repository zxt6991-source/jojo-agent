# jojo-agent 实时语音对话最终优化方案（修订版）

> 文档版本：v2.0  
> 日期：2026-10-17  
> 项目：`zxt6991-source/jojo-agent`  
> 适用平台重点：macOS arm64 / Electron  
> 状态：最终设计方案，替代上一版语音优化方案

---

## 0. 修订结论

上一版方案的方向基本正确，但实施顺序和几个关键接口需要调整。

本版做出以下核心修正：

1. **先建立基线、回放测试和延迟测量，再调阈值。**
2. **先重构实时播放链路并验证 AEC，再开放 Barge-in。**
3. **先解决 LLM 流式输出 → 可朗读文本 → 流式 TTS，降低首音延迟。**
4. **语音 Prompt / Coding Agent 口语策略前置，这是最低成本、最高收益改动之一。**
5. **不默认引入 FunASR + PyTorch。优先评估现有 sherpa-onnx 栈中的 Streaming Paraformer + Silero VAD。**
6. **Smart Turn 放入常驻 Python Speech Sidecar，VAD `stop_secs=0.2` 作为官方推荐基线。**
7. **CosyVoice 不再直接定为最终 TTS。先在目标 Mac 上跑 benchmark，再决定选型。**
8. **TTS 改为会话级文本流式接口，而不是“每个短句独立 synthesize”。**
9. **打断采用两阶段：先 duck/pause，再确认 true interruption 后 flush；假打断则恢复。**
10. **“停止说话”和“取消 Agent Run”彻底解耦。**
11. **被用户打断后，下轮上下文只能认为用户听到了实际已播放部分。**
12. **连续监听需要独立的授权、资源、预缓冲、空闲超时、静音和播放优先级设计。**
13. **Coding Agent 场景不朗读 diff、命令输出、文件列表；只播报短摘要和真实进度。**
14. **TTFA 改为分段预算，不再把 `<1200ms` 当成未验证的绝对承诺。**

---

# 1. 当前架构基线

当前 `speech.md` 定义的语音链路仍是本地优先：

```text
Renderer AudioWorklet
        ↓
PCM16LE / 16 kHz / mono
        ↓
Main / Worker
        ↓
Python helper + sherpa_onnx SenseVoice
        ↓
录音结束后一次 final
        ↓
Agent Run
        ↓
最终已提交 assistant message
        ↓
/usr/bin/say
        ↓
完整临时 WAV
        ↓
缓存
        ↓
独立隐藏 AudioHost
        ↓
Blob URL 播放
```

当前已经做得比较好的部分应继续保留：

- `captureId`
- `generation`
- PCM sequence 校验
- ACK / backpressure
- Worker / Main / Renderer 分层
- `VoiceCommitLedger`
- Run 去重
- 独立 PlaybackBroker
- TTS 缓存
- Scheduler Delivery Outbox
- 审批播报与业务审批解耦
- “停止声音不取消 Agent Run”
- 云端语音适配器已经删除
- 录音当前由用户主动触发
- 老 generation 的结果不能进入新轮次

这些是实时语音改造时最应该保护的约束，而不是推翻重做。

---

# 2. 真实问题重新排序

当前“人机感重”不是单一问题，而是 5 类问题叠加。

## 2.1 输出太慢

```text
Agent 等完整回答
    ↓
TTS 等完整文本
    ↓
生成完整 WAV
    ↓
才开始播放
```

这直接决定首音延迟。

优先级：**最高**

---

## 2.2 输出不像口语

Coding Agent 回复可能包含：

- Markdown
- 代码块
- diff
- 路径
- 命令
- 文件列表
- 大段技术解释

这些内容即便换成最自然的 TTS，也仍然很“机器”。

优先级：**最高，且改造成本最低**

---

## 2.3 播放层不支持真正实时控制

当前 AudioHost 是：

```text
完整音频资产
→ Blob URL
→ HTML 播放器
```

实时语音需要：

```text
PCM chunk
→ ring buffer
→ AudioWorklet
→ sample/segment cursor
→ pause / duck / resume / flush
```

这是 Barge-in 的基础。

优先级：**最高架构风险**

---

## 2.4 输入轮次不自然

当前是：

```text
用户主动开始
用户主动结束
final ASR
```

缺少：

- VAD
- 自动 endpoint
- Smart Turn
- partial transcript
- pre-roll
- continuous session

优先级：**高**

---

## 2.5 不支持自然打断

要真正支持：

```text
AI 正在说
用户插话
AI 立即收声
判断是真抢话还是“嗯”
真抢话 → 停止后续语音
假打断 → 恢复
```

这要求：

```text
流式播放
+
AEC
+
VAD
+
ASR
+
TurnController
```

因此不能过早做。

---

# 3. 实施原则

## 原则 1：先测，再定阈值

以下数字不能靠经验直接写死：

- endpoint 延迟
- ASR partial 延迟
- final/commit 延迟
- Smart Turn 推理耗时
- TTS 首 PCM
- 播放启动延迟
- Barge-in 停声延迟
- false interruption rate
- 中文 Smart Turn 准确率

全部先进入 benchmark / replay harness。

---

## 原则 2：Barge-in 必须晚于 AEC

依赖关系：

```text
Streaming Playback
        ↓
AEC verified
        ↓
Continuous Capture while Speaking
        ↓
Barge-in
```

没有 AEC 时，不开放默认扬声器 Barge-in。

---

## 原则 3：停止语音 ≠ 取消 Run

必须保留当前原则：

```text
stop speaking
```

只影响：

- TTS session
- playback queue
- voice delivery

默认不影响：

- 正在写文件
- 正在执行命令
- 正在运行工具
- 正在提交 patch
- Agent Run

原因是工具执行可能有副作用。

只有用户明确要求：

```text
“停止这个任务”
“取消操作”
```

且 Runtime 本身允许安全取消时，才进入：

```text
Agent Run cancellation
```

---

## 原则 4：屏幕内容与口语内容允许不同

以后不要继续假设：

```text
display text == spoken text
```

应该是：

```text
Agent Output
   ├── Display Projection
   └── Voice Projection
```

屏幕负责完整性。

语音负责：

- 简短
- 自然
- 当前进度
- 结论
- 必要追问

---

## 原则 5：优先复用 sherpa-onnx 运行时

当前 SenseVoice 已经通过 `sherpa_onnx` 运行。

因此新方案优先评估：

```text
sherpa-onnx
├── Streaming Paraformer
├── Silero VAD
├── SenseVoice
└── TTS candidates
```

避免第一版就增加：

```text
FunASR
+
PyTorch
+
另一套模型生命周期
```

---

# 4. 最终总体架构

推荐最终结构：

```text
┌──────────────────────────────────────────────────────┐
│               Voice Audio Graph                      │
│         同一实时音频所有权边界                        │
│                                                      │
│  Microphone ── Capture Worklet                       │
│      │                                               │
│      ├── rolling pre-roll                            │
│      │                                               │
│      └── Speech Sidecar input                        │
│                                                      │
│  PCM Playback ── Playback Worklet ── Speaker         │
│      │                                               │
│      ├── ring buffer                                 │
│      ├── playback cursor                             │
│      └── AEC reference tap                           │
└──────────────────┬───────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────┐
│        Persistent Speech Sidecar                     │
│                                                      │
│  sherpa-onnx Silero VAD                              │
│  sherpa-onnx Streaming Paraformer                    │
│  Smart Turn                                          │
│  optional SenseVoice rescore                         │
└──────────────────┬───────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────┐
│           VoiceSession / TurnController              │
│                                                      │
│ listening                                            │
│ user_speaking                                        │
│ maybe_finished                                       │
│ thinking                                             │
│ assistant_speaking                                   │
│ interruption_candidate                               │
│ interrupted                                          │
└──────────────────┬───────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────┐
│              jojo-agent Runtime                      │
│      LLM / Tool / MCP / Memory / Approval            │
└────────────┬───────────────────────┬─────────────────┘
             │                       │
             │ assistant delta       │ runtime events
             ▼                       ▼
┌───────────────────────┐   ┌──────────────────────────┐
│ Voice Text Projector  │   │ Coding Progress Narrator │
│                       │   │                          │
│ stateful normalize    │   │ tool.started             │
│ code/url/path filter  │   │ tool.completed           │
│ spoken summary        │   │ approval.requested       │
└───────────┬───────────┘   └────────────┬─────────────┘
            └──────────────┬─────────────┘
                           ▼
┌──────────────────────────────────────────────────────┐
│              Speech Chunk Scheduler                  │
│                                                      │
│ first-chunk latency policy                           │
│ later chunks follow playback consumption             │
└──────────────────┬───────────────────────────────────┘
                   │ text stream
                   ▼
┌──────────────────────────────────────────────────────┐
│              TTS Session                             │
│                                                      │
│ open → append → finish → cancel                      │
│                 ↓                                    │
│              PCM stream                              │
└──────────────────┬───────────────────────────────────┘
                   │
                   ▼
             Voice Audio Graph
```

---

# 5. 最大架构风险：实时播放 + AEC

这是整个升级中最应该优先做技术验证的部分。

---

## 5.1 当前 AudioHost 不适合直接承担实时对话播放

当前模型：

```text
Worker
  ↓
完整 WAV/MP3
  ↓
Main
  ↓
隐藏 AudioHost
  ↓
Blob URL
  ↓
HTMLMediaElement
```

适合：

- 手动朗读
- 定时提醒
- 完整消息播放

不适合：

- 小块 PCM
- 极低延迟播放
- 快速 pause
- duck
- resume
- 精确 flush
- 已播放位置跟踪
- AEC 参考流

---

# 6. 新增 VoiceAudioGraph

建议把**实时语音模式**的采集与播放收敛到同一个音频所有权边界。

实现上优先：

```text
同一个 Renderer
+
同一个 AudioContext
+
Capture AudioWorklet
+
Playback AudioWorklet
```

或者专门建立：

```text
Realtime Voice Host
```

但该 Host 必须同时拥有：

```text
capture + playback
```

而不是像现在这样：

```text
main renderer = capture
hidden AudioHost = playback
```

---

## 6.1 推荐音频图

```text
getUserMedia
   │
   ▼
Capture Processing
   │
   ├── pre-roll circular buffer
   │
   ├── VAD/ASR sidecar stream
   │
   └── local meter


TTS PCM
   │
   ▼
Playback Ring Buffer
   │
   ▼
Playback AudioWorklet
   │
   ├── playback cursor
   ├── segment boundary
   ├── reference tap
   └── AudioContext.destination
```

---

## 6.2 PlaybackWorklet 必须支持

```ts
interface RealtimePlaybackControl {
  enqueue(chunk: VoicePcmChunk): void;

  duck(reason: string): void;
  pause(reason: string): void;
  resume(): void;

  flush(options?: {
    generation?: number;
    afterSegmentId?: string;
  }): void;

  stop(): void;

  getCursor(): PlaybackCursor;
}
```

其中：

```ts
interface PlaybackCursor {
  segmentId?: string;
  playedFrames: number;
  playedMs: number;
  state:
    | "idle"
    | "playing"
    | "ducked"
    | "paused";
}
```

---

## 6.3 Ring Buffer

不要依赖：

```text
一个 PCM chunk
=
一次独立 AudioBufferSourceNode
```

否则会产生：

- gap
- scheduling jitter
- cancel 不精确
- 大量 node 生命周期管理

推荐：

```text
AudioWorkletProcessor
+
ring buffer
```

通信可选：

```text
MessagePort + transferable ArrayBuffer
```

如果 Electron 当前安全配置允许，再评估：

```text
SharedArrayBuffer
```

但不要为了 SAB 反过来降低安全隔离。

---

# 7. AEC 设计必须通过实机 Gate

## 7.1 不假设浏览器 AEC 一定能覆盖当前拓扑

`getUserMedia({ echoCancellation: true })` 只是请求浏览器启用回声消除。

不能据此假设：

```text
隐藏窗口播放
+
主窗口录音
=
一定拥有正确参考信号
```

尤其当前：

```text
capture renderer
!=
playback AudioHost renderer
```

所以第一步不是写 Barge-in，而是做：

```text
AEC architecture spike
```

---

## 7.2 推荐顺序

### 路线 A：Chromium / system AEC

优先测试：

```text
同一 Voice Audio Graph
+
echoCancellation=true
+
noiseSuppression
+
autoGainControl
```

测试：

- 内置扬声器
- AirPods / 蓝牙耳机
- 有线耳机
- 外接显示器扬声器
- 不同系统音量
- 不同 input/output device

---

### 路线 B：应用可见的 reference PCM

即使优先使用 Chromium AEC，也保留：

```text
playback reference tap
```

因为它可用于：

- AEC 调试
- 回声测试
- 将来 native WebRTC APM
- 计算 playback/capture delay
- replay fixture

---

### 路线 C：Native WebRTC APM

只有浏览器 AEC 不稳定时才进入。

这条路的成本明显更高：

- Electron Native Module
- arm64 构建
- Node ABI / Electron ABI
- notarization
- code signing
- app packaging
- reverse stream
- render/capture alignment
- delay estimation
- device drift

不能把它写成简单的：

```text
“接 WebRTC Audio Processing”
```

---

## 7.3 Barge-in Gate

只有以下测试通过，才能默认开放扬声器 Barge-in：

```text
assistant playback ON
+
user silent
→ 不触发 speech start

assistant playback ON
+
user speaks
→ VAD 可稳定检测真实用户声音

assistant playback ON
+
user overlaps
→ ASR 能识别主要用户内容
```

否则：

```text
Barge-in = disabled
```

耳机模式可以作为更早期实验入口。

---

# 8. TTS 重新选型：先 benchmark，不直接定 CosyVoice

CosyVoice 的双向流式能力值得评估。

但：

```text
官方“最低约 150ms”
```

不能直接等同于：

```text
jojo-agent
+
macOS arm64
+
Apple Silicon
+
生产打包
+
本地 CPU/MPS
```

的实际首 PCM 延迟。

因此本版不再把：

```text
CosyVoice 3
```

写成已确定生产 TTS。

---

# 9. TTS Benchmark Gate

目标设备必须至少包含项目真实目标机：

```text
Apple Silicon
macOS
arm64
```

建议至少跑：

- M1 Pro 16GB
- 如果有条件再跑 M2/M3/M4

---

## 9.1 候选

第一轮：

```text
A. macOS say
B. sherpa-onnx TTS candidates
C. CosyVoice
```

sherpa-onnx 当前已经提供多类 TTS 模型支持，适合作为低依赖候选。

具体模型不要在架构文档中提前锁死，benchmark 时按：

- 中文
- 中英混读
- 技术词汇
- 模型大小
- arm64 推理性能

筛选。

---

## 9.2 Benchmark 指标

每个 TTS 都测：

```text
cold_start_ms
warm_first_pcm_ms
total_generation_ms
RTF
CPU %
peak RSS
package size
cancel_latency_ms
prosody continuity
Chinese MOS subjective score
Chinese-English mixed pronunciation
```

文本集至少：

```text
短句：8~15 字
普通句：30~50 字
长句：100+ 字
数字/日期
英文模型名
代码符号
文件路径
Git 命令
```

---

## 9.3 TTS 决策

只有目标 Mac 上达到：

```text
首 PCM 足够快
+
RTF < 1
+
内存可接受
+
中文自然度合格
+
可稳定取消
```

才进入生产。

否则：

```text
继续 macOS say
```

作为本地 fallback。

如果所有本地候选都无法满足实时对话目标，则单独写 ADR：

```text
是否重新开放 opt-in cloud TTS
```

不能偷偷恢复云端接口。

---

# 10. TTS 接口改为会话级

上一版这种接口：

```ts
synthesizeStream(text)
```

容易造成：

```text
每一小句独立合成
```

导致：

- 韵律断裂
- 声学上下文重置
- 说话风格不连续
- 每块重复初始化

推荐：

```ts
interface RealtimeTtsProvider {
  readonly capabilities: {
    textStreaming: boolean;
    audioStreaming: boolean;
    wordTimings: boolean;
  };

  open(options: TtsSessionOptions): Promise<TtsSession>;
}

interface TtsSession {
  append(textDelta: string): Promise<void>;

  finish(): Promise<void>;

  cancel(reason?: string): Promise<void>;

  audio(): AsyncIterable<TtsAudioChunk>;
}
```

若某个 Provider 不支持：

```text
text streaming
```

Adapter 内部再做 sentence buffer。

上层协议不应该被降级能力绑死。

---

# 11. LLM 流式输出应比 Streaming ASR 更早落地

首音延迟链路：

```text
用户结束
  ↓
endpoint
  ↓
transcript commit
  ↓
LLM first token
  ↓
first speakable phrase
  ↓
TTS first PCM
  ↓
playback
```

其中最容易占掉大量时间的是：

```text
LLM
+
可朗读首句形成
+
TTS
```

因此：

```text
LLM streaming
+
Voice Text Projector
+
TTS streaming
```

不应该排到最后。

---

# 12. 不直接“朗读所有 delta”

当前只读：

```text
最终已经 commit 的 assistant message
```

这个设计解决了：

- 去重
- Run 失败
- 上下文一致性
- 审批乱序
- continuation
- persisted message identity

改成 delta 后，必须新增一层：

```text
Voice Delivery Projection
```

而不是直接：

```text
assistant.delta → TTS
```

---

# 13. Display / Generated / Spoken / Heard 四层状态

推荐明确区分：

```text
generated_text
display_text
spoken_text
heard_text
```

定义：

### generated_text

模型产生过的内容。

### display_text

最终持久化到 UI 的完整助手消息。

### spoken_text

被送入 TTS 的口语内容。

### heard_text

实际已经播放给用户、可以合理认为用户听到的内容。

这是实时语音最关键的数据模型变化之一。

---

# 14. VoiceDeliveryLedger

新增：

```ts
interface VoiceDeliverySegment {
  id: string;

  messageId?: string;
  runId?: string;
  generation: number;

  sourceTextRange?: {
    start: number;
    end: number;
  };

  spokenText: string;

  state:
    | "queued"
    | "synthesizing"
    | "ready"
    | "playing"
    | "partially_played"
    | "played"
    | "interrupted"
    | "cancelled"
    | "failed";

  playedMs?: number;
}
```

作用：

- 防止重复播报
- 支持打断
- 知道用户实际听到哪里
- 支持 Run final 对账
- 支持 outbox partial playback
- 支持 crash recovery

---

# 15. 被打断后的上下文语义

这是必须新增的规则。

例：

完整模型输出：

```text
“问题在 PlaybackBroker。首先应该把 AudioHost 改成……然后再……”
```

用户实际只听到：

```text
“问题在 PlaybackBroker。首先应该……”
```

然后说：

```text
“不对，我问的是 ASR。”
```

下一轮模型上下文不能默认用户已经听完完整消息。

---

## 15.1 推荐实现

持久会话仍可以保存完整：

```text
display message
```

但语音下一轮进入 Runtime 前做：

```text
Voice Conversation Context Projection
```

若上一条 assistant 被打断：

```text
replace previous assistant context
=
last_confirmed_heard_prefix
+
[assistant was interrupted here]
```

屏幕历史仍保留完整结果。

模型语境只按：

```text
heard prefix
```

处理。

---

## 15.2 heard prefix 精度

第一版不要求逐字对齐。

可以按：

```text
最后一个完整播放完成的 semantic speech segment
```

作为边界。

这会略微低估用户听到的内容，但不会高估。

以后 TTS 如果提供：

```text
word timing
```

再升级到 word-level heard cursor。

---

# 16. Stateful Voice Text Projector

现有 `normalizeSpeechText()` 面向完整字符串。

实时输出必须改为：

```text
stateful parser
```

需要维护：

```text
codeFenceOpen
inlineCodeOpen
markdownLinkPending
urlPending
tableState
listState
numberBuffer
dateBuffer
pathCandidate
```

---

## 16.1 默认不读

以下内容默认不直接朗读：

```text
``` code fence
diff
Markdown 表格
长 URL
完整文件路径
hash
JSON
堆栈
命令完整输出
tool call
internal reasoning
```

---

## 16.2 Coding Agent 中的处理

屏幕：

```text
修改了：
packages/speech/...
apps/desktop/...
...
```

语音：

```text
“我改好了，主要调整了语音播放和会话状态。具体文件我放在屏幕上了。”
```

而不是：

```text
“packages slash speech slash src slash……”
```

---

# 17. Chunk Scheduler：首块和后续块采用不同策略

上一版统一：

```text
max_wait = 250~500ms
```

会强行切半句话。

本版改成：

```text
首块：latency oriented
后续：buffer oriented
```

---

## 17.1 第一块

目标：

```text
尽快让 AI 开口
```

但仍优先等待：

```text
自然标点
+
最小可说语义单元
```

只有第一块允许：

```text
first_chunk_deadline
```

超时后在可接受弱边界切分。

---

## 17.2 后续块

不要固定每 250ms 切。

应该根据：

```text
当前播放队列剩余音频时长
```

补充。

例：

```text
playback buffered > 1.5s
→ 等更完整句子

playback buffered < 500ms
→ 尽快提交下一个自然短句
```

这是：

```text
consumer-driven chunking
```

比固定时间窗口自然。

---

# 18. Coding Agent 专用语音策略

jojo-agent 不是普通聊天机器人。

因此 Voice Mode 需要专门覆盖：

- 读文件
- 搜索代码
- 修改文件
- 执行命令
- 编译
- 测试
- 等待工具
- 审批

---

## 18.1 工具运行中的“沉默问题”

工具执行 3~20 秒期间完全无声，会显得非常机器。

可以基于真实 Runtime event 播放简短进度：

```text
file.read started
→ “我看一下这个文件。”

code.search started
→ “我搜一下相关实现。”

command started
→ “我跑一下这个命令。”

test started
→ “我跑一下测试。”

long operation
→ “还在执行，我继续看着。”
```

必须满足：

```text
话术来自真实状态
```

不能为了显得自然而虚构进度。

---

## 18.2 Progress Narration 要限流

避免：

```text
“我在读文件。”
“我在读文件。”
“我在读文件。”
“我在搜索。”
“我又在读文件。”
```

建议：

```text
同类事件合并
+
最短间隔
+
只播报状态变化
```

---

## 18.3 最终 Coding 回复

默认：

```text
语音 = 一句结论 + 必要提醒
屏幕 = 完整结果
```

例：

屏幕上显示完整 patch。

语音：

```text
“已经改完了，核心是把播放改成可流式控制，同时保留现有 Run 不被语音打断。具体改动和测试结果都在屏幕上。”
```

---

# 19. Voice Prompt 进入第一阶段

语音 Prompt 不应该放在架构完成后才做。

它应是第一阶段直接上线的体验优化。

---

## 19.1 通用规则

```text
你当前处于语音交互模式。

- 优先使用短句和自然口语。
- 不朗读 Markdown 结构。
- 不逐项朗读长列表。
- 不复述完整问题。
- 避免“首先、其次、最后”的固定模板。
- 信息不足时直接追问关键条件。
- 屏幕已经展示的复杂细节只做口语摘要。
- 路径、代码、diff、命令输出留在屏幕。
- 工具执行中，只陈述真实发生的动作。
- 不虚构“正在检查”“已经修改”等进度。
```

---

## 19.2 Coding Agent 额外规则

```text
- 技术结论先说结果。
- 文件路径只在必要时说文件名，不朗读完整长路径。
- 代码块不朗读。
- diff 不朗读。
- 命令执行结果只说成功 / 失败和关键错误。
- 多个改动用一句摘要，细节让用户看屏幕。
- 执行耗时较长的真实工具时，可以给一句简短进度提示。
```

---

# 20. Voice Fast Model

TTFA 不只由语音栈决定。

如果用户选择的是：

```text
高推理强度模型
```

那么：

```text
LLM TTFT
```

本身就可能超过整条语音目标。

因此 Voice Mode 应支持：

```text
voice response model
```

策略：

### 模式 A

```text
继续完全使用用户当前模型
```

优点：行为一致。

缺点：高推理模型首音慢。

### 模式 B

```text
Voice Fast Response Model
```

用于：

- 口语确认
- 简短回答
- 进度总结

复杂工具 Run 仍由原模型处理。

本方案建议先做：

```text
可选项
```

而不是强制切换。

---

# 21. Speech Sidecar：常驻，而不是每轮重载模型

当前文档中 SenseVoice 通过 Python helper + sherpa_onnx 调用。

P0 阶段先确认：

```text
当前是否每轮都创建 Python process
当前模型是否每轮重新加载
```

如果存在，则必须改为：

```text
persistent speech sidecar
```

---

# 22. Speech Sidecar 推荐职责

第一版统一承载：

```text
Silero VAD
Streaming Paraformer
Smart Turn
optional SenseVoice
```

未来如果 TTS 也适合 sherpa-onnx，可评估一起放入。

---

## 22.1 不建议第一版引入双运行时

不优先：

```text
sherpa-onnx SenseVoice
+
PyTorch FunASR
```

推荐先：

```text
sherpa-onnx Streaming Paraformer
+
sherpa-onnx Silero VAD
```

原因：

- 已有依赖
- ONNX
- CPU 运行
- arm64 更容易打包
- 模型生命周期更统一
- 减少 RSS
- 减少 Python 环境复杂度

---

# 23. Streaming ASR 的 commit 规则

Streaming ASR 有意义的前提是：

```text
不能最后还无条件等另一套 final
```

第一版建议：

```text
Streaming Paraformer
→ partial
→ endpoint
→ online recognizer final segment
→ commit user turn
```

不要默认再等待：

```text
SenseVoice full final
```

---

## 23.1 SenseVoice 的位置

只有 benchmark 证明：

```text
SenseVoice CER 显著优于 online model
```

且额外延迟可以接受，才加入：

```text
optional final rescore
```

并设：

```text
hard deadline
```

超时直接使用 streaming ASR 已提交结果。

不能让：

```text
partial
```

只服务字幕，却对响应延迟没有任何作用。

---

# 24. Speech Sidecar 协议

推荐常驻进程：

```text
Electron Worker/Main
        ↕
length-prefixed local protocol
        ↕
Python Speech Sidecar
```

优先使用：

```text
stdin/stdout binary framing
```

或：

```text
Unix domain socket
```

第一版没有必要为了本机边车引入网络端口。

---

## 24.1 建议消息

```ts
type SidecarControl =
  | { type: "session.open"; sessionId: string }
  | { type: "session.close"; sessionId: string }
  | { type: "audio.frame"; sessionId: string; sequence: number }
  | { type: "turn.reset"; turnId: string }
  | { type: "cancel"; generation: number };
```

输出：

```ts
type SidecarEvent =
  | { type: "vad.started"; atMs: number }
  | { type: "vad.stopped"; atMs: number }
  | { type: "asr.partial"; text: string }
  | { type: "asr.final"; text: string }
  | { type: "turn.complete"; score?: number }
  | { type: "turn.incomplete"; score?: number }
  | { type: "error"; code: string };
```

日志必须：

```text
stderr
```

避免污染协议 stdout。

---

# 25. Smart Turn 正确接法

Smart Turn 不是：

```text
静音 500ms
→ 再判断
```

推荐基线按官方集成：

```text
Silero VAD stop_secs = 0.2
```

VAD 很快交出 pause。

然后：

```text
Smart Turn
```

决定：

```text
complete
or
incomplete
```

---

## 25.1 不再写死 endpoint_min_delay=300~500ms

这会重复增加等待。

正确做法：

```text
VAD pause
↓
Smart Turn inference
↓
complete?
```

如果 incomplete：

```text
继续听
```

如果长时间未继续：

```text
fallback timeout
```

fallback timeout 需要通过中文样本调参。

---

## 25.2 Smart Turn 放 Python Sidecar

原因：

- Smart Turn 本身是音频模型
- 输入 16k mono PCM
- 需要对应的音频特征处理
- Python 官方实现成熟
- 与 VAD / ASR 放一起减少重复数据搬运
- 避免 Node 再复刻模型前处理

---

## 25.3 中文必须单独评测

不能因为项目写：

```text
multilingual
```

就认为中文自然停顿一定准确。

测试集至少包含：

```text
“我想让你……”
“我想让你先看一下，然后……”
“这个问题吧……其实不是那个。”
“嗯，我觉得……”
“先改第一处。第二处先别动。”
```

并包含：

- 200ms 停顿
- 500ms 停顿
- 1s 停顿
- 句内犹豫
- 中英文混合
- 技术词汇

---

# 26. Pre-roll 是必需项

连续 VAD 会存在：

```text
检测到 speech start
```

时，用户第一个字已经说出一部分的问题。

因此在 VAD 前持续保留：

```text
rolling pre-roll buffer
```

初始建议做成可配置：

```text
300~500ms
```

最终值按回放测试确定。

VAD 起声后，将：

```text
pre-roll + current frames
```

一起送 ASR / Smart Turn。

---

# 27. VoiceSession

连续会话不能再把：

```text
一次录音
```

等同于：

```text
一次语音功能生命周期
```

新增：

```ts
interface VoiceSession {
  start(): Promise<void>;
  mute(): void;
  unmute(): void;
  stop(): Promise<void>;

  getState(): VoiceSessionState;
}
```

状态：

```ts
type VoiceSessionState =
  | "idle"
  | "listening"
  | "user_speaking"
  | "user_maybe_finished"
  | "thinking"
  | "assistant_speaking"
  | "interruption_candidate"
  | "interrupted"
  | "muted"
  | "error";
```

---

# 28. 连续监听的授权和资源模型

连续监听必须由用户显式开启：

```text
Start Voice Session
```

而不是应用启动后后台常驻监听。

会话期间必须有：

- 明显麦克风指示
- 一键 Mute
- 一键 End Session
- 全局快捷键或至少窗口快捷键
- idle timeout
- 屏幕锁定立即停麦
- 睡眠立即停麦
- 输入设备变化处理
- 应用退出立即关闭

---

## 28.1 不默认持久化原始录音

推荐继续保持：

```text
raw PCM only in memory
```

只保留：

```text
短 rolling buffer
```

完成 turn 后尽快释放。

---

# 29. 连续模式下不能再“丢一帧整轮失败”

当前短录音模式：

```text
丢帧 / 乱序
→ 本轮失败
```

对 60 秒以内主动录音是合理的。

对长期连续 session 不合理。

新版应区分：

```text
session integrity
vs
turn integrity
```

例如：

```text
单帧缺失
→ 标记 gap
→ 当前 turn ASR 质量可能下降
→ session 继续
```

严重连续缺失：

```text
reset current turn
```

而不是：

```text
结束整个 VoiceSession
```

---

# 30. 两阶段 Barge-in

这是修订版最重要的行为变化。

不能：

```text
VAD start
→ 立即 flush
```

也不能：

```text
等 ASR 确认
→ 300ms 以后才开始停声
```

正确做法：

```text
Stage 1: reaction
Stage 2: confirmation
```

---

# 31. Stage 1：VAD 后立即 duck / pause

前提：

```text
AEC verified
```

AI 播放时：

```text
AEC-clean capture
↓
VAD detects user speech
↓
Interruption Candidate
↓
duck or pause playback
```

注意：

```text
保留 playback buffer
保留 TTS session
暂不 flush
暂不 cancel Agent Run
```

这样用户会立刻感受到：

```text
AI 在听我
```

---

# 32. Stage 2：确认 true interruption

同时继续：

```text
Streaming ASR
+
duration
+
semantic rules
```

判断：

### True interruption

例：

```text
“等等”
“不是这个”
“先停一下”
“我问的是 ASR”
```

操作：

```text
flush future playback
cancel remaining TTS generation
mark voice delivery interrupted
update heard cursor
进入 user_speaking
```

默认：

```text
不 cancel Agent Run
```

---

### Backchannel

例：

```text
“嗯”
“对”
“好”
“是”
```

操作：

```text
do not create new Run
resume playback
```

---

### False interruption

例：

- 咳嗽
- 键盘声
- 椅子声
- 环境噪音
- 无有效 ASR

操作：

```text
resume playback
```

---

# 33. 打断性能指标拆成两个

原来：

```text
真打断 <250ms 停止
```

与 ASR 确认冲突。

新版改为：

## 33.1 Reaction Latency

```text
user speech starts
→ AI duck/pause
```

目标应尽量低。

这是用户感受到的“立刻停下来听我”。

---

## 33.2 Confirmation Latency

```text
user speech starts
→ true interruption confirmed
```

可以更慢。

因为此时声音已经 duck/pause。

---

## 33.3 Flush Latency

```text
confirmed
→ future playback discarded
```

应非常低。

三者分开测，不再用一个 `<250ms` 混在一起。

---

# 34. Backchannel 提交过滤

不只在播放层判断。

最终 ASR commit 时也必须有：

```text
Backchannel Submission Filter
```

例如 final：

```text
嗯
对
好
是
嗯嗯
```

如果当前仍属于 assistant speaking 上下文：

```text
不启动新 Agent Run
```

只作为：

```text
conversation signal
```

记录或直接丢弃。

---

# 35. Run 与 Speech 生命周期彻底分开

建议：

```text
VoiceTurn
  ├── UserSpeechTurn
  ├── AgentRun
  └── VoiceDelivery
```

三个对象不是同一个生命周期。

---

## 35.1 示例

AI 正在：

```text
运行测试
```

同时口头说：

```text
“我正在跑测试。”
```

用户：

```text
“行，你继续。”
```

这不是：

```text
cancel current run
```

而是：

```text
backchannel / no-op
```

用户：

```text
“别跑了，取消任务。”
```

才进入：

```text
Runtime cancellation policy
```

---

# 36. Scheduler / Reminder 与实时对话优先级

实时对话和 Reminder 共用逻辑仲裁时必须明确优先级。

建议：

```text
P0 user speech
P1 approval-required voice cue
P2 interactive assistant speech
P3 active-run progress narration
P4 scheduled reminder
P5 passive notification
```

规则：

### 用户开始讲话

```text
所有可暂停语音立即 duck/pause
```

### VoiceSession 正在活跃对话

普通 reminder：

```text
延迟到 session idle
```

不要插进一句回答中间。

---

# 37. Outbox 状态新增 partial 语义

当前：

```text
played
```

在流式播放下不够。

建议：

```text
queued
claimed
playing
partially_played
played
interrupted
failed
```

对于 Scheduler：

```text
partially_played
```

不能自动等价于：

```text
delivered successfully
```

具体重播策略需按 reminder 类型决定。

---

# 38. TTFA 改成预算模型

不能只写：

```text
P50 < 1200ms
```

而不拆解。

定义：

```text
T_total =
T_endpoint
+
T_asr_commit
+
T_llm_first_speakable
+
T_tts_first_pcm
+
T_playback_start
```

---

## 38.1 每项都单独记录

```text
T_endpoint
用户真实结束 → turn complete

T_asr_commit
turn complete → transcript ready

T_llm_ttft
Run start → first text delta

T_first_speakable
first delta → first safe oral phrase

T_tts_first_pcm
append first phrase → first PCM

T_playback_start
first PCM → speaker playback
```

---

## 38.2 `<1200ms` 作为条件目标

只有 benchmark 证明：

```text
ASR
+
用户当前模型
+
TTS
```

能满足预算时，才把：

```text
P50 < 1200ms
```

设为发布门槛。

否则 UI/Voice Mode 应：

- 允许使用 fast voice model
- 提前给真实进度反馈
- 不虚报不可能达到的总体数字

---

# 39. P0：先建 Benchmark + Replay Harness

这是新版第一阶段。

在改架构前先得到：

```text
baseline
```

---

## 39.1 当前链路至少测

```text
record_end
asr_final
run_started
llm_first_token
assistant_final_commit
tts_start
tts_ready
playback_started
playback_ended
stop_requested
playback_stopped
```

---

## 39.2 Replay Fixture

建立：

```text
tests/fixtures/speech/
```

建议覆盖：

```text
01-normal-question.wav
02-mid-sentence-short-pause.wav
03-mid-sentence-long-pause.wav
04-backchannel-en.wav
05-backchannel-dui.wav
06-cough.wav
07-keyboard.wav
08-speaker-echo.wav
09-overlap-interruption.wav
10-long-utterance.wav
11-code-terms.wav
12-path-and-url.wav
13-background-human-speech.wav
```

---

## 39.3 事件断言

例如：

```text
backchannel-en.wav
```

期待：

```text
vad.started
asr.final="嗯"
interruption=backchannel
agent_run.created=false
```

---

```text
09-overlap-interruption.wav
```

期待：

```text
vad.started
playback.ducked
asr.partial
interruption.confirmed
playback.flushed
tts.cancelled
agent_run.cancelled=false
```

---

# 40. P1：Voice Prompt + Coding Narration

这是成本最低、收益最高的一阶段。

完成：

- voice response mode
- Coding Agent 口语规范
- 不朗读代码/diff/path
- 真实 tool progress 话术
- progress narration 限流
- 可选 voice fast model
- approval 固定安全话术继续保留

这一阶段即使完全不改 ASR/TTS，也能明显降低“读屏软件感”。

---

# 41. P2：Realtime Playback + AEC Spike

完成：

- VoiceAudioGraph
- Playback AudioWorklet
- PCM ring buffer
- pause / duck / resume / flush
- playback cursor
- reference tap
- capture/playback 同一 ownership
- Chromium/system AEC 实机测试
- 建立 AEC replay / overlap 测试

**本阶段不开放正式 Barge-in。**

Gate：

```text
AEC passed
```

否则后续 Barge-in 不进入默认配置。

---

# 42. P3：TTS Benchmark + Session API

完成：

```text
TTS provider benchmark
```

候选：

```text
macOS say
sherpa-onnx TTS
CosyVoice
```

同时先建立：

```text
open
append
finish
cancel
```

会话级抽象。

最终 Provider 根据 Mac benchmark 决定。

不是在架构文档里提前指定。

---

# 43. P4：Streaming LLM → Voice Projection → Streaming TTS

这是首音延迟的关键阶段。

完成：

- assistant delta 接入
- Stateful Voice Text Projector
- first-chunk scheduler
- consumer-driven later chunks
- VoiceDeliveryLedger
- display / spoken / heard 分离
- Run failure 对账
- interrupted context projection
- streaming PCM playback

完成后，即使仍然按键录音，也会从：

```text
用户说完
→ 等完整答案
→ 等完整 TTS
```

变成：

```text
用户说完
→ LLM 首个自然短句
→ TTS
→ 开始说
```

这一阶段对 TTFA 的收益往往比 partial ASR 更直接。

---

# 44. P5：Persistent Speech Sidecar + Streaming ASR + VAD

完成：

```text
persistent Python sidecar
```

优先：

```text
sherpa-onnx Silero VAD
sherpa-onnx Streaming Paraformer
```

加入：

- partial transcript
- pre-roll
- online final commit
- continuous turn audio stream
- gap tolerance
- model warm keep-alive

SenseVoice 先保留为现有 fallback。

是否加入：

```text
final rescore
```

由 benchmark 决定。

---

# 45. P6：Smart Turn + Auto Endpoint

完成：

- Smart Turn sidecar integration
- `VAD stop_secs=0.2` baseline
- Chinese conversation corpus
- complete / incomplete decision
- fallback timeout
- turn state machine
- auto submit

从这里开始可以真正去掉：

```text
必须点击结束录音
```

---

# 46. P7：Continuous VoiceSession

完成：

- explicit start
- persistent mic indicator
- mute
- end session
- idle timeout
- screen lock stop
- sleep stop
- rolling buffer
- turn-level recovery
- continuous listening state

此时仍可以：

```text
AssistantSpeaking 时暂时不允许 speaker Barge-in
```

直到 P2 AEC Gate 通过。

---

# 47. P8：Two-stage Barge-in

依赖：

```text
P2 AEC passed
+
P5 VAD/ASR
+
P6 Smart Turn
+
P7 VoiceSession
```

完成：

```text
VAD
→ duck/pause
→ ASR classify
→ true / backchannel / false
```

规则：

```text
true
→ flush TTS
→ preserve Agent Run
→ update heard cursor

backchannel
→ resume
→ no new Run

false
→ resume
```

---

# 48. P9：高级优化

最后再做：

- preemptive context preparation
- speculative intent preload
- adaptive endpoint tuning
- word-level heard alignment
- better false interruption recovery
- optional native AEC
- optional full duplex speech-to-speech research
- Moshi / speech-native backend experiment

---

# 49. 阶段依赖图

阶段不是简单的线性排队。

推荐：

```text
                  ┌──────── P1 Voice UX
                  │
P0 Baseline ──────┼──────── P2 Audio/AEC ───────────────┐
                  │                                      │
                  ├──────── P3 TTS Benchmark              │
                  │            │                          │
                  │            ▼                          │
                  │          P4 Streaming Output          │
                  │                                      │
                  └──────── P5 Speech Sidecar             │
                               │                          │
                               ▼                          │
                             P6 Smart Turn                │
                               │                          │
                               ▼                          │
                             P7 VoiceSession              │
                               │                          │
                               └──────────────┬───────────┘
                                              ▼
                                         P8 Barge-in
                                              │
                                              ▼
                                         P9 Advanced
```

其中最高风险验证：

```text
P2
P3
```

可以与：

```text
P1
```

并行进行。

---

# 50. 推荐代码结构

```text
packages/
├── contracts/
│   └── src/
│       ├── speech.ts
│       ├── speech-ui.ts
│       ├── voice-session.ts
│       ├── voice-delivery.ts
│       └── realtime-audio.ts
│
├── speech/
│   └── src/
│       ├── voice-session.ts
│       ├── turn-controller.ts
│       ├── voice-text-projector.ts
│       ├── voice-chunk-scheduler.ts
│       ├── voice-delivery-ledger.ts
│       ├── interruption-classifier.ts
│       ├── coding-progress-narrator.ts
│       │
│       ├── tts/
│       │   ├── realtime-tts-provider.ts
│       │   ├── macos-say-adapter.ts
│       │   ├── sherpa-tts-adapter.ts
│       │   └── cosyvoice-adapter.ts
│       │
│       └── sidecar/
│           ├── protocol.ts
│           └── client.ts
```

Desktop：

```text
apps/desktop/
├── renderer/
│   └── voice/
│       ├── voice-audio-graph.ts
│       ├── capture-worklet.ts
│       ├── playback-worklet.ts
│       ├── playback-ring-buffer.ts
│       └── voice-session-ui.ts
│
├── main/
│   └── speech/
│       ├── playback-coordinator.ts
│       ├── speech-sidecar-host.ts
│       └── voice-session-host.ts
│
└── worker/
    └── speech/
        ├── narration-controller.ts
        └── voice-run-bridge.ts
```

Sidecar：

```text
scripts/speech-sidecar/
├── main.py
├── protocol.py
├── vad.py
├── streaming_asr.py
├── smart_turn.py
└── benchmark.py
```

最终目录应按现有仓库实际分层调整，不要求机械照搬。

---

# 51. 关键接口汇总

## 51.1 VoiceSession

```ts
interface VoiceSession {
  start(): Promise<void>;
  mute(): void;
  unmute(): void;
  stop(): Promise<void>;

  state(): VoiceSessionState;
}
```

---

## 51.2 VoiceAudioGraph

```ts
interface VoiceAudioGraph {
  startCapture(): Promise<void>;
  stopCapture(): Promise<void>;

  enqueuePcm(chunk: VoicePcmChunk): void;

  duck(reason: string): void;
  pause(reason: string): void;
  resume(): void;
  flush(): void;

  cursor(): PlaybackCursor;
}
```

---

## 51.3 TTS

```ts
interface RealtimeTtsProvider {
  open(options: TtsSessionOptions): Promise<TtsSession>;
}

interface TtsSession {
  append(textDelta: string): Promise<void>;
  finish(): Promise<void>;
  cancel(reason?: string): Promise<void>;
  audio(): AsyncIterable<TtsAudioChunk>;
}
```

---

## 51.4 TurnController

```ts
interface TurnController {
  onVadStarted(): void;
  onVadStopped(): void;

  onAsrPartial(text: string): void;
  onAsrFinal(text: string): void;

  onSmartTurnComplete(): void;
  onSmartTurnIncomplete(): void;

  onPlaybackStarted(): void;
  onPlaybackPaused(): void;
  onPlaybackEnded(): void;
}
```

---

# 52. Generation 继续作为防竞态核心

所有实时事件都携带：

```ts
interface VoiceGenerationContext {
  voiceSessionId: string;
  turnId: string;
  generation: number;
}
```

适用于：

- PCM capture
- VAD
- ASR
- Smart Turn
- Agent delta
- TTS
- playback
- narration
- interruption

当语音 delivery 被真正打断：

```text
speechGeneration++
```

只使：

```text
旧 TTS / playback
```

失效。

不要顺手让：

```text
AgentRun generation
```

一起失效。

因此建议进一步拆成：

```text
runGeneration
speechGeneration
```

避免“停声音”误伤 Agent Run。

---

# 53. 新增关键测试矩阵

| 场景 | 预期 |
|---|---|
| 正常提问 | 自动正确结束并回答 |
| 句中 300ms 停顿 | 不抢答 |
| 句中 1s 犹豫 | Smart Turn 尽量继续等待 |
| “嗯” | 不启动新 Run |
| “等等” | duck → confirm → flush |
| 咳嗽 | duck 后恢复或不触发 |
| 键盘声 | 不创建 user turn |
| AI 扬声器回声 | AEC 后不触发用户说话 |
| AI+用户重叠 | 用户语音仍可识别 |
| TTS 中断 | 下轮上下文只认为 heard prefix 已听到 |
| Tool 长执行 | 有限、真实进度播报 |
| Reminder 插入 | 活跃对话时延迟 |
| ASR frame gap | 当前 turn 可恢复，session 不崩 |
| Sidecar crash | fallback / restart，不污染新 generation |
| TTS crash | fallback 到本地系统 TTS 或文字模式 |
| 锁屏 | 麦克风立即关闭 |
| mute | 不再产生 user turn |

---

# 54. 发布 Gate

## Gate A：Audio

必须证明：

- PCM streaming 无明显 gap
- pause / resume 稳定
- flush 可控
- cursor 可用
- 长时间运行不累积 buffer

---

## Gate B：AEC

必须证明：

- 扬声器播放时静音用户不会自触发
- 用户与 AI 重叠时仍能识别用户
- 目标 Mac / 主要设备组合可用

否则：

```text
speaker barge-in disabled
```

---

## Gate C：TTS

必须证明：

- Mac arm64 warm first PCM 达标
- RTF 达标
- 稳定 cancel
- 中文自然度可接受
- 内存和包体可接受

否则：

```text
不切生产 TTS
```

---

## Gate D：Turn Detection

中文 replay corpus：

- premature turn rate
- missed endpoint rate
- endpoint latency

达到目标后再开启：

```text
auto endpoint
```

---

## Gate E：Barge-in

分别统计：

```text
reaction latency
confirmation latency
false duck rate
false interruption rate
missed interruption rate
resume success rate
```

不要只统计一个“停止延迟”。

---

# 55. 关于 CosyVoice 的最终结论

CosyVoice：

```text
保留为高优先级候选
```

但不是：

```text
当前已经确定的默认生产方案
```

原因不是模型能力不足，而是：

```text
目标设备是 macOS arm64
```

必须以真实 Mac benchmark 为准。

官方的双向流式和低延迟数据只能证明：

```text
架构上值得测试
```

不能替代：

```text
本项目设备实测
```

---

# 56. 关于 sherpa-onnx 的最终结论

优先级应提升。

现有项目已经依赖：

```text
sherpa_onnx + SenseVoice
```

当前 sherpa-onnx 也提供：

- streaming ASR
- Streaming Paraformer
- Silero VAD
- 多种 TTS
- macOS
- arm64

因此第一条工程路线应是：

```text
尽量在 sherpa-onnx 体系内完成：
VAD + Streaming ASR
```

而不是立刻增加 PyTorch FunASR。

---

# 57. 关于 Smart Turn 的最终结论

保留 Smart Turn。

但接法修正为：

```text
VAD stop_secs=0.2
↓
Smart Turn
↓
complete/incomplete
```

而不是：

```text
先固定多等 300~500ms
↓
再 Smart Turn
```

并且：

```text
中文表现由自建 replay corpus 决定
```

---

# 58. 关于 Barge-in 的最终结论

保留，并作为最终“人味”核心能力。

但必须满足：

```text
AEC
+
streaming playback
+
pause/duck/resume
+
ASR
+
interruption classifier
+
heard cursor
```

采用：

```text
VAD → duck/pause
ASR → confirm
true → flush
false/backchannel → resume
```

而不是：

```text
VAD → flush
```

---

# 59. 关于“边生成边说”的最终结论

不能简单：

```text
LLM delta → TTS
```

必须经过：

```text
Assistant Delta
↓
Voice Text Projector
↓
Stateful Normalizer
↓
Speech Chunk Scheduler
↓
VoiceDeliveryLedger
↓
TTS Session
↓
Playback Cursor
```

并保证：

```text
display
spoken
heard
```

三种语义不会混在一起。

---

# 60. 最终优先级

真正建议开发顺序：

```text
P0  Baseline + Replay Harness
P1  Voice Prompt + Coding Narration + Fast Model Option
P2  Realtime PCM Playback + AEC Spike
P3  TTS Benchmark + Session API
P4  LLM Streaming + Voice Projection + Streaming TTS
P5  Persistent Speech Sidecar + sherpa Streaming ASR + VAD
P6  Smart Turn + Auto Endpoint
P7  Continuous VoiceSession
P8  Two-stage Barge-in
P9  Advanced Optimization
```

这比上一版更符合：

```text
收益
+
依赖关系
+
工程风险
```

---

# 61. 最终目标体验

Coding Agent 场景：

```text
用户：
“你看看 speech 这块为什么打断不自然。”

AI：
“我先看一下现在的播放和录音链路。”

[屏幕上开始读取文件]

AI：
“我找到一个关键点。现在录音和播放不在同一个实时音频链路里。”

用户：
“嗯。”

AI：
继续，不创建新 Run。

AI：
“我准备先把播放改成流式 PCM，再验证回声消除。”

用户：
“等等，先别改代码，我只要方案。”

AI：
立即降低/暂停声音。

系统确认是真打断。

后续 TTS 被取消，
但已经运行的无副作用分析 Run 可以继续完成。

下一轮模型只认为用户听到了打断前的部分。

AI：
“好，那我只整理方案，不动代码。”
```

这才是 `jojo-agent` 应该追求的语音交互。

不是：

```text
把文字回答朗读出来
```

而是：

```text
让 Agent 的听、想、做、说、停、被打断，
都处于同一个可控的实时会话模型里。
```

---

# 62. 参考资料

## jojo-agent

- `docs/technical-implementation/speech.md`
- https://github.com/zxt6991-source/jojo-agent

## Pipecat Smart Turn

- https://docs.pipecat.ai/pipecat-cloud/guides/smart-turn
- https://github.com/pipecat-ai/smart-turn

官方当前建议 Smart Turn 配合短 VAD stop，`stop_secs=0.2` 为推荐默认值。

## sherpa-onnx

- https://github.com/k2-fsa/sherpa-onnx
- https://k2-fsa.github.io/sherpa/onnx/
- https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-paraformer/paraformer-models.html

当前支持 Streaming Paraformer、Silero VAD、TTS，以及 macOS / arm64。

## CosyVoice

- https://github.com/FunAudioLLM/CosyVoice

官方提供 text-in / audio-out streaming 能力；实际 macOS arm64 延迟必须由本项目 benchmark 决定。

## Chromium / WebRTC AEC

- https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackConstraints/echoCancellation
- https://issues.chromium.org/issues/40504498
- https://chromium.googlesource.com/chromium/src/

AEC 是否覆盖具体 Electron 多窗口播放拓扑不能凭接口声明推断，必须在目标 Electron/macOS 构建上实测。

---

# 63. 一句话定版

> **先把“说得快、说得像人、播放可控、AEC 可验证”做扎实，再做连续监听和打断；优先复用 sherpa-onnx，TTS 以 Mac 实测选型，Barge-in 用“两阶段暂停→确认”，且永远把“停声音”与“取消 Agent Run”分开。**
