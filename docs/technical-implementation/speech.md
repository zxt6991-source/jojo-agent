# Speech 实现

文档状态：2026-10-17。语音仅保留本地 SenseVoice ASR 与 macOS 系统 TTS；云端语音适配器、网络协议、语音密钥存储 / 传递和云端测试脚本已删除。早期[语音对话与定时语音提醒设计](../jojo-voice-conversation-and-scheduled-reminders-design.md)中的云端章节仅为历史方案，当前接口以本文和代码为准。

桌面链路包含按键录音、转写校正 / 自动发送、Run 去重、最终助手正文朗读、独立 AudioHost、音色预设及试听、审批固定短句、长回复继续朗读、缓存清理和本次启动统计。Scheduler 支持纯提醒 Target、持久 Delivery Outbox、任务结果播报、系统通知和显式托盘常驻，详见 [Durable Scheduler](./scheduler.md)。连续监听 / 插话以及硬件、通知与签名包实机验收仍待完成。

## 包和公共接口

| 位置 | 职责 / 公共入口 |
|---|---|
| `packages/contracts/src/speech.ts`、`speech-ui.ts` | 本地语音设置、Provider Port、错误、资产 Port、严格控制事件与二进制帧 |
| `packages/providers` | `createSpeechProvider(settings, options?)`；可注入本地进程执行离线测试 |
| `packages/speech` | `SpeechService`、`normalizeSpeechText()`、`speechCacheKey()`；无 Electron 依赖 |
| `packages/storage` | 配置迁移、`SqliteSpeechAssetStore`、`VoiceCommitLedger`、ScheduleRun / Delivery Outbox |
| `packages/scheduler` | 纯提醒 Dispatcher、分目的地 claim / ACK / 恢复与有限重试 |
| Desktop Main | 录音权限、流桥接、严格 IPC、播放仲裁与 AudioHost |
| Desktop Worker | 本地 ASR / TTS 生命周期、消息读取、语音提交 / Run 关联 |
| Desktop Renderer | AudioWorklet PCM、录音 UI、转写草稿、语音设置与最终消息朗读入口 |
| `scripts/setup-local-speech.mjs` | 显式安装 Python 环境和官方 SenseVoice 模型；输出路径 |
| `scripts/local-speech-smoke.ts` | 本地 ASR / TTS smoke；不播放、不下载、不修改用户设置 |

语音工厂独立于文字 Provider / ModelDiscovery，只创建 `provider.asr.id=sensevoice` 与 `provider.tts.id=macos`。不接收语音 Key、endpoint 或资源 ID，不读取文字模型凭据。

ASR 输入为 PCM16LE / 16 kHz / mono，常规包 6,400 bytes / 200 ms。SenseVoice 使用 Worker 内嵌的 Python helper 调用已配置环境中的 `sherpa_onnx`，固定 CPU 推理；模型目录需包含 `model.int8.onnx`（也兼容 `model.onnx`）和 `tokens.txt`。结束录音并排空 PCM 后返回一次 `final`，没有实时 partial。运行时不下载模型、不发送录音到云端，取消会终止本地子进程和音频消费。

macOS TTS 通过 `/usr/bin/say` 从 stdin 接收文字，合成为私有临时 WAV，固定 PCM16LE / 24 kHz / mono，校验后进入缓存与 AudioHost；`say` 不直接播放，临时输出会清理。`default` 优先选择已安装中文声音，不自动下载音色，非 macOS 平台明确返回不可用。未完成的 `.part` 不能用于播放。

## 配置与迁移

语音设置仅包含本地识别参数、系统声音、音色预设、输入设备与播放偏好。ASR 的 `local` 保存 `pythonPath`、`modelDirectory`、`language`；TTS 的 `speakerId` 为 `default` 或已安装的系统声音名，`speechRate` 为 -50…100 的整数。录音 PCM 固定 16 kHz，合成 WAV 固定 24 kHz。语音配置、快照和保存接口不包含密钥字段：快照为 `{ settings }`，保存输入为 `{ settings }`。

旧语音配置在持久配置读取边界归一化：全本地配置保留开关、模型路径、语言、系统声音和偏好，并清除旧协议 / 资源字段；使用旧云端服务的配置转为禁用的本地配置，需要重新完成测试后显式启用。切换到系统朗读时，旧云端音色恢复为 `default`。文字模型、权限、记忆及其他配置继续保留。新语音 Schema 严格拒绝云端服务、Key 和任意 endpoint；兼容迁移不开放新的云端运行入口。

主输入框的麦克风在语音未启用时进入设置页，顶部说明缺少的转写 / 试听验证。首次配置需保存 Python 与模型路径，主动完成两项测试，再点击“启用语音并保存”；此后麦克风直接开始录音。更改服务参数后需重新验证；已启用配置仅修改音量、输入方式等偏好无需每次重启重测。安装脚本和命令行 smoke 不会自动启用 Desktop 语音。

`voicePresets` 最多 20 项，ID 唯一；每项保存 `id`、`name`、`speakerId`、`speechRate`，只覆盖系统声音与语速。预设修改后先保存再试听，预设试听不替代默认声音的全局 TTS 验证。删除预设后，关联任务须重新选择并保存。

## 音频缓存和所有权

`SpeechService` 先规范化可朗读文字，再计算缓存键。键包含文字 hash、实际 `tts.id`、speakerId、speechRate、format、sampleRate、文字规范化版本和适配器协议版本；不同系统声音参数不能复用彼此的音频。音频事件及缓存资产的格式、采样率必须匹配当前 TTS 配置。账号凭据不进入缓存键，也不落入音频 manifest。

设置中的显式语音试听验证使用 `forceProvider=true`，每次都跳过 ready 缓存查询并调用当前所选 TTS 服务。本地试听验证当前系统音色与合成能力。只有当前请求正常完成才授予验证状态。普通消息朗读继续复用缓存。

`SqliteSpeechAssetStore` 由 Worker 独占写入 `runtime/speech.sqlite` 和音频目录。SQLite 内区分可复用音频实体与 session / schedule / test 的 owner 引用。同一个缓存实体可以对应不同授权引用；读取 ready 资产必须匹配引用 ID 与 owner。Main 不能把任意本地路径作为播放授权，也不并行修改该数据库。

写入先进入私有 `.part`，在 `completed` 后按实际格式原子发布为 `.mp3` 或 `.wav` 并登记 ready manifest。`speech_asset_meta` 的资产 schema 从 1 无损迁移到 2，为实体增加默认 `mp3` 的 `format` 列，保留原有 MP3 文件、metadata 和 owner 引用；它与同文件中的 VoiceCommitLedger 版本独立。错误和取消会撤销未完成文件。缓存默认总量 256 MiB、单资产最多 8 MiB、期限 7 天；释放 owner 会取消其未完成 writer，并回收没有引用的实体。缓存清空和 Worker 关闭均会结束活动 writer。

设置页的“清除语音缓存”通过 Main / Worker 受控入口停止当前朗读、取消正在准备的声音并清理本机音频资产。任务准备状态同时失效，不能继续显示旧缓存为 ready；下一次朗读或投递按需重新合成。该操作不重跑任务，也不改变已完成的文字投递或历史状态。

`speech.sqlite` 还保存 `VoiceCommitLedger`，按 voiceTurnId / generation 预留固定 runId 与输入 hash，再进入 App Service / Runtime。重试核对双侧 Run 记录；已存在返回原 runId，未知启动状态不会自动创建第二次 Run。对应的用户消息、App Service origin 和 Runtime execution metadata 保留 voiceTurnId / generation，可追溯到录音轮次。该元数据使用现有可选 JSON 字段，未提高 application / runtime SQLite 版本。

对话播放由 Main 内存队列仲裁；Scheduler 播报另有 `scheduler.sqlite` 的持久 claim / ACK。ScheduleRun 的终态和该次运行各目的地 Outbox 在同一事务提交，不能以 `speech.sqlite` 的 ready 资产或 Main 队列作为成功投递记录。

## 桌面录音与语音提交

主窗口录音必须由用户操作触发。Main 同时校验 Permission Check / Request 的可信 webContents、main frame、页面 URL、audio-only 请求和当前录音句柄；macOS 另检查系统麦克风授权，Forge 写入 `NSMicrophoneUsageDescription`。关闭页面、锁屏、休眠或取消会关闭当前录音任务，旧 generation 的异步结果不能进入新轮次。

AudioWorklet 作为 JavaScript 模块包含在生产包中，支持输入设备选择、mono downmix 与抗混叠重采样为 PCM16LE / 16 kHz。每包 6,400 bytes，最长 60 秒；录音仅驻留内存，不落盘。UI 提供点击 / 按住说话、波形、时长、结束和取消。

主输入框使用简洁的麦克风图标，位于底部模型选择与发送按钮之间；仅在录音 / 转写期间展开状态条，保持文字输入区整洁。转写校正 / 自动发送在语音设置页调整；未启用语音时点击图标进入设置。

音频通过独立 MessagePort 传输，不进入普通 JSON WorkerCommand。Renderer / Main / Worker 分别校验 captureId、generation、顺序和大小；最多 8 个未确认帧、ACK 超时 2 秒。Worker 在 Provider 消费后才确认，结束帧等待所有音频排空。背压、丢帧或失序使本轮失败，不把截断录音当成功。

ASR final 默认回填编辑框，用户可校正后发送；`auto_send` 仅在本轮非空 final 后提交。设置中的转写验证不创建会话或 Run。正常提交保留现有模型、Lane、工具权限与审批；上一轮仍忙时保留草稿，并提供“停止任务并发送”，等待取消 settle 后提交。

## 独立播放宿主

单条“朗读”接受 sessionId / messageId 和可选规范化正文 offset；Worker 重新从持久会话读取助手纯文本，排除 tool_call / internal 消息，确定性整理 Markdown，本地 WAV 每段最多 200 个 Unicode 码点，避免慢语速时超出共享音频大小限制及截断代理对；继续朗读的 offset 按实际已读长度计算。返回 `nextOffset` 后，界面提供“继续朗读”下一段；每段由用户主动触发，自动朗读不能传入非零 offset。全文仍在原会话中，不另存一份语音对话正文。自动朗读只消费本轮 operation 的最终已提交消息 ID，跳过空正文、其他会话、录音期间和重复事件；不监听全局文本 delta。停止声音不取消 Agent Run。

用户主动开启“自动朗读已完成的助手回复”后，当前会话出现待审批操作时可播报一次固定短句“需要你确认一项操作，请在界面中查看并确认。”。Worker 在合成前后核对 sessionId / approvalId 仍待审批，关闭或切换审批会取消旧声音。播报不包含命令、文件差异或审批正文，也不会调用批准入口；授权仍由原审批 UI 和 Permission Governance 决定。

提交文字或转写草稿时，明确的“不要自动朗读”“不要自己读”“只用文字回复”等停读指令会先阻断自动回复 / 审批播报、停止当前会话声音，并持久保存 `autoReadReplies=false`，随后原文继续作为普通任务输入。停读规则跳过引号、代码及翻译 / 示例中的指令，不会据此自动开启朗读。手动点击“朗读”和独立语音提醒不受自动回复开关影响。

Main 使用独立的自动朗读 epoch 与请求标识，在合成完成、入队和真正发声前复核开关；关闭后再开启也不恢复旧自动请求。只修改自动朗读偏好不重建 Worker 语音服务，避免取消录音、手动合成或定时提醒。用户可在设置页主动重新开启自动朗读。

Main 验证 ready 资产归属、期限、大小、格式对应的文件后缀与缓存目录，拒绝路径越界和符号链接，再把有界 MP3 / WAV 字节及显式格式交给专用 AudioHost。AudioHost 使用隔离、sandbox 的隐藏窗口与最小 preload，不暴露 DesktopApi / Node，不获取麦克风权限，也不依赖聊天组件挂载。音频使用对应 `audio/mpeg` / `audio/wav` 的本地 Blob URL，旧版未传格式的内部调用按 MP3 兼容；只有真实播放器 started / ended ACK 才更新 playing / played，无法解码的音频不能登记 played。

PlaybackBroker 保证单播放器串行与有界队列，执行录音互斥、锁屏、配置静默时段和音量策略。收到输出设备变化、宿主崩溃或 autoplay 拒绝后停止并阻止自动恢复；用户再次主动朗读 / 试听或在有效期内明确重新播报才可恢复，旧队列会撤销。

设备变化事件的可见性受浏览器权限和平台影响；耳机拔出、系统默认输出切换、真实麦克风及签名 macOS / Windows 安装包仍需实机验收，不以模拟事件测试替代。

## 定时提醒与任务结果播报

`target.kind=reminder` 只保存 1–200 字符固定文案，不需要会话、Provider、模型或项目目录，到期通过 `ReminderScheduleDispatcher` 完成，不创建 Agent Run。它仍复用 once / interval / cron、occurrence 去重、misfire、并发和稳定 execution ID 恢复路径。需要查询天气等执行工作时继续使用 Agent / Team / Workflow Target，语音是独立 delivery 目的地。

`delivery.voice` 指向 `local-desktop`，可选择固定文案或已完成的任务结果，并配置 1 秒至 7 天有效期。固定提醒按 `scheduledFor + expiresAfterMs` 计算过期，任务结果按 `finishedAt + expiresAfterMs` 计算。固定内容可提前合成至 schedule owner 缓存；预缓存失败不会改变提醒执行或文字投递结果，也不会先播放。

创建 Run 时冻结名称、目标、配置 revision 和目的地；准备投递时固定正文、消息 ID、创建时间和音色版本。Desktop 的 Agent 结果只从持久 Operation 的 `finalEntryId` 读取最终助手正文，排除 internal / tool_call；Server 只读取持久完成快照的最后一条纯文本助手消息。运行预览、工具输出和实时 delta 均不作为播报来源。结果不可用时使用固定的“任务已完成，请查看结果。”，不会调用模型补写摘要。

每个目的地分别保存 Outbox item。Worker 唯一写入 Scheduler 和音频数据库；Main 收到的播放请求绑定 itemId、claimToken、playbackId、generation，并定期续租。读取 ready 音频后、真正调用 `host.play` 前，Main 必须先取得 Worker 将该 claim 持久登记为 `playing` 的 ACK。这个提前状态表示可能即将产生声音；只有 AudioHost 正常 ended 与有效 claim 的终态确认才能登记 `played`。队列接受、ready、claimed、系统通知成功或任务 completed 均不代表已播完。

失效租约、晚到 ACK 或旧 generation 不能改变新 attempt。崩溃窗口内已经授权播放的 item 保守标记 `uncertain`，不自动重播。播放前的受控暂时失败 / 超时由 Outbox 统一有限重试；系统声音缺失、参数等永久失败停止重试。过期、静音、中断与不确定状态分别保留。删除任务或关闭其语音投递会撤销尚未播放的 item；显式“重新播报”仍复核当前配置、有效期和播放策略。

Automations 可通过 `delivery.voice.presetId` 选择独立系统音色，未选择时使用默认声音。`presetVersion` 绑定实际本地声音参数，修改关联声音后旧快照被抑制；删除或缺失的 preset 明确失败，不回退默认声音。

任务详情轮询读取当前 schedule revision 的准备状态：`not_prepared`、`preparing`、`ready`、`failed`、`unavailable` 或 `dynamic`。ready 还核对资产期限与实际 owner 引用，缓存过期 / 被回收后不保留假 ready。启用任务的固定提醒与 fixed 文案自动预缓存；暂停或已完成的任务仍可由用户主动试听。只有已保存且草稿未变、全局语音已启用的固定内容可试听，采用该任务保存的音色，并使用独立 test owner；不会创建 Run、向对话投递或改变 Outbox。动态结果在任务完成后才生成，试听不会为取得样本文本而执行 Agent。

Headless Server 提供 Agent 与 Reminder Target，拒绝启用 `local-desktop` voice，因为没有已注册的本机播放设备。

## 后台、静默与系统通知

语音设置中的 `backgroundRunning` 默认 false。用户显式开启“关闭窗口后继续运行（托盘）”后，关闭主窗口隐藏到可见托盘，停止当前录音和朗读，Worker / Scheduler 继续运行；托盘提供打开 Jojo、停止当前朗读和退出。退出动作关闭 Worker、音频宿主与任务服务。该功能没有注册 OS 用户服务，也没有设置开机自动启动。

设置页可配置带 IANA 时区的静默时段和锁屏安静偏好。后台提醒仍服从全局语音开关、录音互斥、锁屏、静默时段与过期限制；解锁或唤醒不会重新播放已经抑制 / 不确定的声音。系统休眠中不能保证准时触发，恢复时由 Scheduler 的 misfire 与每条 voice 有效期分别决定是否补执行、是否还能播放。

系统通知使用静默 OS 通知，正文固定为“定时任务已到，请打开 Jojo 查看结果。”，不显示提醒或任务结果正文；点击打开 Jojo。`delivered` 表示 OS 的 show 事件确认，并不证明用户看见或读过通知。Electron 离线模式模拟通知成功，真实 macOS / Windows 的权限、焦点模式、通知显示与点击体验需要 P1-D 实机验收。

## 本次启动统计

Worker 的 `SpeechDiagnosticsCollector` 汇总 ASR / TTS 实际 Provider 尝试的成功、失败、取消次数，以及 ASR 音频时长、TTS 请求字符数、实际生成的音频字节数和缓存命中。数据只在当前 Worker 内存中保存，重启归零；不保存文字、录音、资产路径或 Key。设置页折叠区通过“刷新统计”读取最新快照，不周期轮询。

平均值与 P95 分别使用各类最近最多 100 次 Provider 尝试的请求总耗时样本，次数和用量则从本次启动累计。ASR 请求总耗时包含录音与本地推理，不能当作结束说话到 final 的延迟；TTS 请求总耗时不能当作首音播放延迟。缓存命中不算一次 Provider 请求。首音 / 停止延迟、结束后转写延迟与 Outbox 积压汇总尚未纳入本轮统计，仍需后续测量。

## 本地语音首次配置与 smoke

macOS 可使用本地 SenseVoice 转写与系统声音朗读，不需要语音 API Key。首次准备需要 Python 3.9–3.12，并由用户显式运行安装命令；安装过程会联网获取固定版本的 Python 依赖与官方 SenseVoice int8 模型。普通录音、朗读和设置保存不会触发下载。

在仓库根目录执行：

```bash
pnpm speech:setup --python /usr/bin/python3
pnpm speech:smoke:local --tts-only
```

如果模型站点需要通过本机已有代理访问，可只为安装命令指定其端口，例如：

```bash
pnpm speech:setup --source huggingface --proxy http://127.0.0.1:7897 --diagnose-download
```

`--proxy` 只接受带显式端口的本机 HTTP / HTTPS / SOCKS5h 地址，不接受账号、密码或远端代理地址；它仅用于本次下载，不修改系统网络设置，也不写入语音设置。指定后直接使用系统 HTTPS 下载器。已安装 Python 依赖时可加 `--skip-install`。

安装器默认将环境放在仓库的 `.local-speech/venv`，模型放在 `.local-speech/models/SenseVoiceSmall`；输出可填写到设置页的 `pythonPath` 和 `modelDirectory`，不自动修改用户设置或密钥。可用 `--python` 选择其他兼容的 Python，用 `--directory` 改变安装目录。默认从官方 GitHub Release 下载；Node HTTPS 连接失败时只尝试一次系统 curl。也可显式指定 `--source huggingface`，使用官方示例引用的作者仓库固定提交，并核对模型 SHA256；不会自动切换来源。`--diagnose-download` 仅输出受控 HTTP 状态 / 退出码。模型目录至少需要 `model.int8.onnx` 和 `tokens.txt`；安装器也保留官方样本 `test_wavs/zh.wav`。模型文件未完整下载和校验通过前，不会宣称安装成功。

若当前网络不能访问模型站点，先在可访问网络下重新运行 `pnpm speech:setup --source huggingface --diagnose-download`。也可从[作者模型仓库](https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/tree/2365baeacb507f821a0c8120fcee3d484dba7a07)取得 `model.int8.onnx`、`tokens.txt`，放入同一目录后在设置中选择。模型准备完成后才能验证并启用本地转写。

下载完成后，使用安装器输出的模型目录，提供官方样本的绝对路径运行本地 ASR + TTS smoke：

```bash
pnpm speech:smoke:local -- \
  --python /absolute/path/to/jojo-agent/.local-speech/venv/bin/python3 \
  --model-directory /absolute/path/to/jojo-agent/.local-speech/models/SenseVoiceSmall \
  --wav /absolute/path/to/jojo-agent/.local-speech/models/SenseVoiceSmall/test_wavs/zh.wav
```

`--tts-only` 不依赖 Python 或 ASR 模型；完整 smoke 先测试固定短句的系统 TTS，再读取指定 WAV 并去除容器头，将 16 kHz / mono / PCM16LE 原始音频送给本地 ASR。脚本不播放声音、不下载资源、不读取云端 Key、不保存转写正文或合成音频，也不改变 Desktop 设置；只输出完成状态、格式、字节数和识别字符数。省略 Python / 模型参数时使用仓库默认 `.local-speech` 路径。

在 Jojo「语音设置」中填写安装器输出路径并先保存。主动完成录音转写与合成试听两项验证后，点击“启用语音并保存”。缺少模型、Python 依赖或系统音色会显示不可用。

## 离线验证

在仓库根目录执行，以下测试不读取真实 Key、不请求真实音频服务：

```bash
pnpm exec vitest run \
  packages/contracts/test/speech.test.ts \
  packages/providers/test/sensevoice-asr.test.ts \
  packages/providers/test/macos-tts.test.ts \
  packages/providers/test/local-speech-registry.test.ts \
  packages/speech/test/speech.test.ts \
  packages/speech/test/metrics.test.ts \
  packages/storage/test/config-migration.test.ts \
  packages/storage/test/sqlite-speech-asset-store.test.ts \
  packages/storage/test/speech-service.integration.test.ts \
  apps/desktop/src/main/speech-settings.test.ts \
  apps/desktop/src/main/ipc/settings-ipc.test.ts \
  apps/desktop/src/worker/speech-runtime.test.ts \
  apps/desktop/src/worker/voice-tasks.test.ts \
  apps/desktop/src/worker/pcm-upload-stream.test.ts \
  apps/desktop/src/worker/committed-speech-reply.test.ts \
  apps/desktop/src/main/speech-stream.test.ts \
  apps/desktop/src/main/speech-host.test.ts \
  apps/desktop/src/main/playback-broker.test.ts \
  apps/desktop/src/main/audio-host.test.ts \
  apps/desktop/src/audio-host/player.test.ts \
  apps/desktop/src/worker/schedule-voice-preset-version.test.ts \
  packages/storage/test/voice-commit-ledger.test.ts \
  packages/storage/test/voice-run-metadata.integration.test.ts
pnpm typecheck
pnpm lint
```

离线测试覆盖进程生命周期、PCM 边界、取消 / 超时、错误分类、正常完成、文字规范化、缓存参数差异、`.part` / ready 发布、owner 隔离、配置迁移及严格拒绝旧语音 Key。夹具使用离线 Provider 与合成媒体流，不替代真实硬件、模型音质或通知验收。

2026-10-17 本地安装复验：通过本机现有代理显式下载作者仓库固定提交的 SenseVoice 模型及配套文件，模型约 228 MiB，SHA256 与固定值一致；代理仅用于本次安装命令。隔离环境 Python 3.9.6、NumPy 1.26.4、sherpa-onnx 1.13.8 导入通过。真实本地 smoke 同时完成 macOS TTS（24 kHz mono WAV，149,850 bytes）及 SenseVoice 官方中文样本 ASR（非空 final，14 个 Unicode 码点），进程正常结束；重复安装检查在不联网的路径下复用现有完整文件。模型位于仓库 `.local-speech/models/SenseVoiceSmall`，Python 位于 `.local-speech/venv/bin/python3`，均在 Git 忽略目录。安装器新增临时本机代理参数的 15 项离线测试及相关 Lint 通过。本次使用官方样本，未调用实体麦克风、未播放合成音频，也未改写用户的语音配置或密钥；在设置页填写路径后仍需主动录音和试听，再启用语音。

Electron 离线端到端验收命令：

```bash
pnpm --filter @desktop-agent/desktop build:e2e
pnpm --filter @desktop-agent/desktop exec playwright test \
  -c playwright.electron.config.ts \
  e2e/speech.spec.ts e2e/voice-conversation.spec.ts e2e/audio-host.spec.ts \
  e2e/server-state-compatibility.spec.ts
```

2026-10-17 移除云端语音后的复验：全仓 Vitest 回归及受沙箱端口限制用例的外部复验通过，TypeScript、ESLint、架构、操作绑定和生成文档检查通过。6 项 Electron 用例覆盖本地设置保存 / 重启、录音校正 / 自动提交、消息朗读、定时播报、历史数据兼容及 MP3 / WAV 通用播放。设置页已确认没有语音 Key 或云端服务选项，宽窄窗口截图已检查。真实本地 smoke 再次完成系统 WAV 合成（149,850 bytes）和官方中文样本转写（14 个 Unicode 码点），没有播放声音或改写用户设置；实体麦克风和 OS 通知仍按下节验收。

## 实机验收边界

- [ ] 实体麦克风的权限、输入设备切换、中文 / 中英混合识别质量与结束后延迟。
- [ ] 系统声音的音质、播放 / 停止延迟、默认输出设备与耳机切换。
- [ ] 签名安装包加载 Python helper、AudioWorklet、AudioHost 与缓存存储。
- [ ] 实机通知、托盘关闭 / 退出、锁屏静默、睡眠后 misfire 与过期策略。

离线回执不证明用户看见通知或听到声音。系统睡眠期间不保证准点提醒。
