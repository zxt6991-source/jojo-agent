# Speech 实现

文档状态：2026-10-22。语音使用本地 SenseVoice（默认）或显式配置的 Streaming Paraformer + Silero，以及系统 TTS 或可选的本机 Qwen3 神经音色；云端语音适配器、网络协议、语音密钥存储 / 传递和云端测试脚本已删除。早期[语音对话与定时语音提醒设计](../jojo-voice-conversation-and-scheduled-reminders-design.md)中的云端章节仅为历史方案，当前接口以本文和代码为准。

## v2 实施状态与入口

本轮按[实时语音最终优化方案 v2](../jojo-agent_voice_optimization_final_v2.md)实现了可运行的首批桌面链路。默认仍是主动录音与本地系统声音；不会自动开启麦克风、下载模型或切换生产 TTS。

| 阶段 | 本轮落地 | 发布边界 |
|---|---|---|
| P0 | 有界分段延迟统计、事件 replay harness、13 类录音清单、真实 Mac TTS 基准、中文录音接入与模型回放评测脚本 | 实体中文、回声与重叠录音尚缺；事件夹具不能作为声学验收 |
| P1 | 语音 Run 口语指令、自动朗读短摘要、代码 / diff / 路径过滤、真实工具进度限流、可选口语摘要模型 | 摘要模型只处理已完成回答，任务执行仍使用原模型；摘要失败 / 超时回退本地投影 |
| P2 | 同 Renderer / AudioContext 的采集与 PCM 播放、Worklet ring、cursor、pause / duck / resume / flush、可选 reference tap、AEC Gate | 实验开关内启用，未通过实体 AEC，不开放扬声器插话 |
| P3 | 会话级 open / append / finish / cancel、原生 PCM 与完整 WAV 兼容、有界背压与取消；MeloTTS / CosyVoice3 CPU 候选；可选 Qwen3 MLX 神经音色及 Mac 实测 | 系统声音仍兼容旧配置；设置页可显式选择本机自然声音。Qwen3 实时会话直接交付原生 PCM；系统声音保留完整 WAV 适配。Gate C 主观听感 / 设备验收未签发 |
| P4 | 语音 Run delta → 状态化投影 → 消费驱动分句 → 会话 TTS → 独立 PCM MessagePort → Worklet；持久交付账本、final 对账、已听上下文投影 | 设置页显式启用“实验：语音提问后边生成边朗读”，同时需启用自动朗读；文字 Run 仍用完成回执 |
| P5 | 常驻 stdio Speech Sidecar 已接 Desktop SpeechService；逐帧 ACK、实时字幕、单次 online final、跨轮模型复用、断链 / 取消清理 | 需在设置页显式选择 Paraformer 并验证本地模型；SenseVoice 默认保留。运行时不下载，不隐式重识别 |
| P6 | Smart Turn 真实 CPU 推理、短 VAD pause、complete / incomplete / 失败超时回退、自动端点已接桌面、模型与手动结束可并用；按实时速度回放、标注哈希校验、提前截断 / 漏端点 / 延迟评测 | 默认手动；设置页可显式选择“实验：停顿后自动结束”。中文实录语料未验收，不作为默认发布能力 |
| P7 | 桌面连续对话入口、每轮校正 / 自动提交、回复播放后重新收音、静音 / 恢复 / 结束、窗口快捷键、空闲超时、锁屏 / 睡眠 / 设备切换终止；损坏或空白轮次有限重录恢复 | 半双工：播放期间关闭麦克风；音频中断丢弃本轮并重录，尚非允许单帧缺失后保留当前 ASR 的无限流 |
| P8 | 两阶段打断分类、duck / resume / flush、backchannel 与旧 generation 隔离、已听上下文 | 真实 AEC 与重叠语音 Gate 未过，扬声器自然插话不开放 |
| P9 | 未实施 | 自适应阈值、逐字对齐、native AEC 与 speech-native 后端仍是后续研究 |

新配置 `realtimeReplies` 默认 false，兼容旧配置。`voiceResponseModel` 是可选的已配置文字模型，仅用于普通完成回复的短口语摘要，最多等待 5 秒；实验流式输出使用原任务模型及语音指令。语音设置页可手动刷新 ASR final、模型首字、首个可朗读短句、首 PCM 和播放启动等 P50 / P95，未观测到的阶段不虚填数值。停止语音、切换会话、锁屏、睡眠、撤销自动朗读或断开输出设备都会终止相应语音 delivery，不调用 Agent Run 的取消入口。

实时分段会合并已投影的相邻短句，在 180 字预算内共享一次合成与韵律上下文；首个短回应的 400 ms 收集预算从首个模型 delta 开始，投影弱边界与短句合并共用这一预算，后续短片段最多等 200 ms，final 可立即释放。保留缓冲高低水位、源范围、已听确认与取消语义；无源范围的工具进度不能并入回答。这样避免“好的。”等极短句反复启动独立合成。

## 2026-10-22：长文音色随机漂移

中文与中英混合全文沿用同一 `speakerId`、语速和自动语言条件；设置发生变化会停止当前阅读，没有逐段自动切换音色或失败后换引擎的路径。但每一段都独立调用 CustomVoice，原先共享的 MLX 随机状态会受预热、前序朗读、其他声音试听和取消影响；缓存还可能拼接不同历史随机状态下生成的片段。

现在每次通过输入校验且未预先取消的合成，都在 `model.generate` 前执行 `mx.random.seed(0)`，预热也走同一路径。取消仍先同步 GPU、关闭生成器和清理 decoder，再允许下次请求。固定种子不来自文字或 requestId，所有片段使用同一采样起点；保留 checkpoint 的温度、自动语言、原生 PCM、首段 80 / 后续 200 字和生成上限。神经音频缓存升级到 `v4-checkpoint-sampling-seed0-auto-language`，旧 v2 / v3 音频不再命中，其他 TTS 的缓存规则不变。

固定随机种子消除的是同文、同音色的请求顺序差异，不是跨文本声纹一致性的保证。MLX-Audio 0.5.9 的 CustomVoice 路由不把 `ref_audio/ref_text` 交给生成器，也没有可直接复用的跨请求生成上下文；本轮没有伪造参考音频或把上一段 decoder 状态强行续接。不同语言和文本仍可能产生韵律及听感差异，必须用样音确认；固定种子也可能让某段文字稳定复现模型缺陷，原有失败上限与错误处理继续生效。

新增 `scripts/neural-voice-consistency.ts`：读取修改前 Sidecar 的独立副本，分别运行旧版和当前实现，按生产分段规则合成固定中文和混合长文，生成逐段及连续 WAV；随后插入另一音色、测试 `default` / Serena 等价映射、首 PCM 后取消及模型重启，再比较同一段文字的 PCM 哈希。输出目录必须为新目录，报告逐条落盘；不下载、不播放、不改用户配置，失败不会删除已有样音。PCM 哈希相等只证明同文复现，不作为跨文本音色评分。

```bash
pnpm --filter @desktop-agent/providers exec tsx ../../scripts/neural-voice-consistency.ts \
  --baseline-script /absolute/before/mlx_tts.py \
  --output-dir /absolute/new-listening-directory
```

旧 Sidecar 的目录须同时保留同版 `protocol.py`。本次基线为本轮修复前的 v3 checkpoint 参数实现，除请求级 seed 外生成参数相同。

Apple M4 Pro 的[真实对照记录](./voice-qwen3-consistency-2026-10-22.json)覆盖 338 字中文（67 / 187 / 84 字三段）与 468 字符混合文本（71 / 200 / 197 字三段）。两版各完成 15 次合成和 1 次首 PCM 后取消，分别启动 2 个模型进程，包含主动重启。中文、混合首段在另一声音试听后、default 别名、取消后、重启后共 8 次复测：旧版 0 / 8 与首次 PCM 一致，新版 8 / 8 完全一致。连续样音保存在本机忽略目录 `.local-speech/voice-previews/consistency-20261022`；未进行听感打分，不把 PCM 一致率解释为跨段声纹相似度。

另外[两轮完整语料回归](./voice-qwen3-seed0-regression-2026-10-22.json)的 16 次合成全部完成，未触及生成上限；warm 首 PCM P50 / P95 为 172 / 177 ms，取消确认 123 ms，取消后首 PCM 170 ms，全程 1 个模型进程。相对前一轮 176 / 180 ms 没有观察到延迟回退，两次独立运行的差异不作为速度提升声明。通过 404 项相关 TypeScript、11 项 Python 测试，以及类型、相关 Lint、架构、文档一致性和桌面构建检查。

两项真实模型 Electron 回归也通过：中英全文滚动朗读，以及实时三轮 `played → interrupted → played`。[本轮桌面记录](./voice-qwen3-desktop-seed0-2026-10-22.json)首 PCM 中位数 203 ms，首 PCM 至播放器消费中位数 5.0 ms。仍使用模拟 ASR / LLM、隔离配置及物理静音；关闭测试应用时记录了 `runtime_closing` 取消日志，两项断言通过，不把测试通过等同于无日志警告或声学验收。

## 2026-10-22：对齐模型采样配置

排查此前 `synthesis_limit`：MLX-Audio 0.5.9 的流式 `token_count` 是每批增量，0.8 秒批次为 10 tokens；149 次回调后，第 150 批达到 1500 tokens，被 Sidecar 拒绝并返回失败。计数没有重复累加，EOS 也没有被过滤；这是模型未及时结束生成，不能通过把截断音频标记为完成来修复。

本轮将显式采样参数对齐固定 checkpoint 自带配置：`temperature=0.9`、`top_p=1.0`、`top_k=50`、`repetition_penalty=1.05`。此前前两项为 0.7 / 0.9；现在不再依赖库的隐式默认值。保留 1500 tokens、120 秒音频上限、0.8 秒原生批次与自动语言识别；缓存策略升级为 v3，避免继续复用旧策略音频。上游也有[采样默认值导致异常长音频的报告](https://github.com/Blaizzy/mlx-audio/issues/994)，但其模型和调用路径不同，只作为排查线索，不作为本机修复的证明。

针对同一 42 字合成句子，使用 seed 0–23 分别运行新旧参数，共 48 次。诊断上限为 400 tokens，与生产 1500 tokens 不同。两组均未触及上限，旧 / 新参数整段生成耗时中位数为 2,483 / 2,275 ms，音频时长中位数 11,360 / 10,800 ms；最大音频时长分别 23,440 / 24,320 ms。这个对照没有复现历史超限，因此不能声称已经消除该问题。详见[完整逐条记录与方法限制](./voice-qwen3-seeded-sampling-2026-10-21.json)。可用 `scripts/diagnose-mlx-generation.py` 复现固定语料和随机种子，不播放音频；没有听感或转写验收。

生产通路随后使用相同 8 类语料跑两轮，16 条全部完成，取消及恢复也完成，全程只启动 1 个模型进程：

| 指标 | 本轮实测 |
|---|---:|
| warm 首 PCM P50 / P95（15 条） | 176 / 180 ms |
| 冷启动至首 PCM | 2,072 ms |
| 取消确认 | 134 ms |
| 取消后首 PCM | 172 ms |

[两轮完整报告](./voice-qwen3-checkpoint-sampling-2026-10-22.json)保留所有请求。另一次较早复测在第二轮 long 开始后失败，报告相对路径的父目录缺失又掩盖了原始错误；其[不完整记录](./voice-qwen3-sampling-incomplete-2026-10-21.json)单独保留，错误码和耗时均不推测，不计入成功分母。脚本已增加合成前的报告目录检查，复现应传绝对路径。历史失败和这次小样本通过均不能替代更长时间的稳定性及实体听感验收。

本轮通过 334 项相关 TypeScript 测试、10 项 Python 协议测试，以及类型、Lint、架构、文档一致性和桌面构建检查。两项真实模型 Electron 回归通过：中英全文滚动朗读，以及实时三轮 `played → interrupted → played`。后者首 PCM 中位数 195 ms，首 PCM 至播放器消费约 5.3 ms；[桌面记录](./voice-qwen3-desktop-sampling-2026-10-22.json)仍使用模拟 ASR / LLM、隔离配置及物理静音，不代表完整真实对话或声学验收。

```bash
.local-speech/venv-mlx-tts/bin/python3 -B scripts/diagnose-mlx-generation.py --report /absolute/new-seeded-diagnosis.json --seeds 24
pnpm speech:benchmark --provider mlx-qwen3 --output native --iterations 2 --report /absolute/new-checkpoint-sampling.json
```

## 2026-10-21：取消后复用模型与明确朗读预热

Qwen3 MLX 通过 `tts.ready.cooperativeCancel` 声明协作取消能力。停止时先丢弃待播放的 PCM，再发出绑定 requestId 的 `tts.cancel`；Python 在生成批次边界关闭迭代器，同步 GPU 并重置 decoder 的流状态，最后确认 `tts.cancelled`。Worker 排空并校验旧 PCM，只有收到匹配的确认才释放串行队列供下一次合成复用模型。完成与取消交叉到达也必须经过这一屏障；取消无响应超过 750 ms、协议异常、启动中取消、配置变更或退出仍终止进程。已经完整生成的请求只需丢弃下游缓冲，不驱逐空闲模型。该确认耗时不是扬声器停止耗时，播放端仍立即 flush。

文字明确要求“请朗读 / 读给我听”等时，在 Run 成功启动后预热当前本机模型，与 LLM 生成回答重叠；即使关闭“语音输入后自动朗读回复”，本轮明确朗读授权仍可预热。普通文字、远程 Channel、关闭语音或非 MLX 引擎不会触发。取消 / 失败的 Run、停止朗读、会话释放、配置失效和退出会撤销对应预热；预热只丢弃内部音频，不产生可播放资产和播放事件。

同一 Apple M4 Pro 与固定 MLX-Audio 0.5.9 的两次独立专项测试，每次包含冷短句、warm 短句、长句取消和短句恢复：

| 取消时机 | 取消确认 | 下一请求至首 PCM | 本次进程数 |
|---|---:|---:|---:|
| 发起后 50 ms，首 PCM 前 | 127 ms | 176 ms | 1 |
| 发起后 600 ms，已有 3 次原生回调 | 82 ms | 177 ms | 1 |

相较 10 月 20 日取消后重载的 2,082 ms，这两次恢复均无需冷启动；这是两个专项样本，不是完整语料分位数或用户端响应时间。分别见[首 PCM 前取消](./voice-qwen3-cancel-before-pcm-2026-10-21.json)和[输出中取消](./voice-qwen3-cancel-during-pcm-2026-10-21.json)。本轮完整语料测试在 sentence 再次触发已有的 `synthesis_limit`，发生在取消测试之前；[失败报告](./voice-qwen3-warm-cancel-2026-10-21.json)保留已完成样本，不计入成功验证。这一模型稳定性问题尚未解决。

本轮通过 468 项相关 TypeScript 测试、9 项 Python 协议测试、3 项隔离 Electron 用例，以及类型、Lint、架构、文档一致性检查和桌面构建。真实神经实时输出经 Worker → MessagePort → AudioWorklet 验证三轮 `played → interrupted → played`；首 PCM 的三轮中位数 210 ms、最大 1,167 ms，包含尚未完成预热的首次请求，首 PCM 到播放器消费约 5.4 ms。[桌面取消恢复记录](./voice-qwen3-desktop-cancel-2026-10-21.json)采用真实 TTS、合成 ASR 和离线模拟 LLM，物理输出静音；识别和端到端响应指标不代表真实对话。另两项桌面用例验证关闭自动朗读时的明确文字请求，以及真实 Serena 中英全文滚动播放。

专项复现（新报告路径，不覆盖已有文件）：

```bash
pnpm speech:benchmark --provider mlx-qwen3 --output native --scenario cancel-recovery --iterations 2 --cancel-after-ms 50 --report /absolute/new-before-pcm.json
pnpm speech:benchmark --provider mlx-qwen3 --output native --scenario cancel-recovery --iterations 2 --cancel-after-ms 600 --report /absolute/new-during-pcm.json
```

## 2026-10-20：首段延迟优化

`SpeechTtsProvider.synthesizePcm` 是可选能力，只有 Qwen3 MLX 原生路径声明 `audioStreaming: true`。实时会话边读边交付 24 kHz PCM16，每包最多 20 ms；末尾保留一个采样点，只有 provider 完成后才附带完整帧数和 final。未知总长不能生成提前的 heard / played 回执。stdout 消费受高水位约束，背压通过 Node 流和 OS 管道传回 Python；WAV 合成、PCM 合成与预热共享一个有界串行队列。

主动开始录音且已开启语音输入后的自动朗读时，后台预热当前 Qwen3 模型并丢弃预热音频，以便与用户说话和识别重叠。保存设置不会加载模型。录音正常 final 不取消预热；明确取消、会话释放和配置失效会撤销对应预热，旧 generation 不影响新请求。完整朗读采用下述短首段加滚动预取；首句调度共用 400 ms 预算，避免两个 400 ms 等待相叠。

在同一 Apple M4 Pro、固定 Qwen3 0.6B 4bit 版本、MLX-Audio 0.5.9 和相同 8 类文本下，分别运行一次完整 WAV 对照和原生 PCM。首请求为进程冷启动（未清 OS / Metal 缓存），其余 7 类为 warm。不同运行存在随机生成和音频时长差异，属于本机小样本验证，不是线上 SLA。

| 指标 | 完整 WAV 对照 | 原生 PCM |
|---|---:|---:|
| warm 首 PCM P50 | 1,967 ms | 189 ms |
| warm 首 PCM P95 | 6,365 ms | 205 ms |
| 进程冷启动至首 PCM | 1,806 ms | 2,182 ms |
| 取消等待进程退出 | 17 ms | 35 ms |
| 取消后重载至首 PCM | 1,761 ms | 2,082 ms |

warm 首 PCM 中位数减少约 90%，来自提前交付已有的原生音频；整段生成速度没有据此宣称提升。当时的冷启动及取消后重载仍需秒级时间；10 月 21 日已增加上述取消后模型复用。报告分别为[完整 WAV 对照](./voice-qwen3-buffered-validation-2026-10-20.json)和[原生 PCM 验证](./voice-qwen3-native-validation-2026-10-20.json)。较早的两轮原生测试在第二轮 sentence 触发模型生成上限，其[失败记录](./voice-qwen3-native-benchmark-2026-10-20.json)单独保留，不参与成功样本分位数，也未改采样参数掩盖失败。脚本现会保留后续失败前已经完成的逐条指标。

本轮通过 **520 项相关 TypeScript 测试、7 项隔离 Electron 用例**，以及类型、Lint、架构、文档一致性与桌面构建检查。真实 Serena 的中英长文用例验证开播时 `preparedChars` 尚未覆盖全文、最终覆盖全部规范化正文且只有一个最终 played。真实神经实时输出用例经过 Worker → MessagePort → AudioWorklet，两轮首 PCM 分别约 198–325 ms，首 PCM 至播放器开始消费约 5–6 ms，均收到完整 played；[桌面数值记录](./voice-qwen3-desktop-streaming-2026-10-20.json)使用合成 ASR 与离线模拟 LLM，因此其中识别、模型首字和整体响应时间不能外推到真实对话。测试静音且不采集实体麦克风；实际听感和实体设备时延仍需试听判断。

复现时使用新的报告文件名：

```bash
pnpm speech:benchmark --provider mlx-qwen3 --output buffered --iterations 1 --report /absolute/new-buffered.json
pnpm speech:benchmark --provider mlx-qwen3 --output native --iterations 1 --report /absolute/new-native.json
```

## 本机自然声音：Qwen3 MLX

针对系统基础音色的机械感，新增 `provider.tts.id = mlx-qwen3`。设置页“输入与声音 → 朗读方式 → 自然声音 · 本机离线”可选 Serena（默认）、Vivian 等内置声音；保存后即可使用新配置，试听仅用于可选的音色预览。音色预设沿用当前引擎；切换引擎不覆盖旧预设，需重新选择可用声音。模型不支持已验证的语速控制，因此界面保持原速，非零语速在配置 / 进程边界拒绝，避免假装支持。

```bash
pnpm speech:setup:neural                       # 只做离线校验
pnpm speech:setup:neural --download --install-runtime
pnpm speech:benchmark --provider mlx-qwen3 --iterations 1 --report /absolute/new-report.json
pnpm --filter @desktop-agent/providers exec tsx ../../scripts/neural-voice-preview.ts /absolute/new-listening-directory
```

模型固定为 [Qwen3-TTS-12Hz-0.6B-CustomVoice-4bit](https://huggingface.co/mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-4bit/tree/08c72cad5e2fd0f41730c8bd1f28149585e46361)，13 个必需 / 描述文件共 **1,693,603,219 bytes**，权重 / speech codec 使用 LFS SHA256，其余使用 Git blob 摘要。沿用有界大文件续传，校验通过才发布文件。`scripts/mlx-tts-macos-py311.lock.txt` 固定独立运行依赖（MLX-Audio 0.5.9、MLX 0.32.4、Transformers 5.20.1）；当前锁针对 Apple Silicon / macOS 26 / Python 3.11。它与默认 ASR 及 CosyVoice 的 venv 分离。推理环境强制 Hub / Transformers 离线，不传应用密钥，不启用远程模型代码；无需克隆个人声音。

`createBundledNeuralTts` 将经过审查的 Python 与二进制协议源码打包到 Worker，首次明确语音使用时物化，模型在请求间复用。普通回复、实时回复、手动朗读与提醒共享同一 GPU 模型；最多排队 8 个请求，排队取消不会中断正在播报的另一个请求。正在生成时取消优先协作停止并复用模型，超时或异常则等待子进程退出后重新加载。配置变更、清缓存及退出均释放模型；任何失败都不暗中换回系统或云端声音。语言使用模型的 `auto`，避免英文和中英混读被强制按中文生成；缓存键包含引擎、音色、本地模型位置及生成策略版本，不复用旧的固定中文策略音频。

2026-10-18 完整 WAV 适配阶段的 Apple M4 Pro [8 类文本实测报告](./voice-qwen3-mlx-benchmark-2026-10-18.json)包含取消与重载。首次导入 / 加载 / 首次 GPU 编译包含在首次请求中；未清空 OS 文件与 Metal 缓存。warm 来自之后 7 个不同类别；RTF 表内单独统计 warm，原报告汇总则包含首次请求。

| 指标 | 实测 |
|---|---:|
| 首次完整 WAV 首 PCM（含首次运行开销） | 40,023 ms |
| warm 完整 WAV 首 PCM P50 / P95 | 1,992 / 6,126 ms |
| warm 原生 PCM P50 / P95 | 193 / 197 ms |
| warm 生成耗时 / 音频时长中位比值 | 约 0.226 |
| 正在生成时取消 / 取消后重新加载并合成 | 34 / 2,122 ms |
| 直接子进程峰值 RSS | 约 1.93 GB（不等于全系统 GPU 占用） |

上述 2026-10-18 的约 193 ms 仅是当时的二进制管道观测，不能作为当时的播放时延；2026-10-20 已接入下述原生 PCM 会话通路。固定日常对话样音保存于忽略目录 `.local-speech/voice-previews/natural-v1`，含同文 Tingting / Serena / Vivian / Uncle_Fu；Serena 与 Vivian 的自动 SenseVoice 回转写与原句一致（忽略标点），这仅检查内容，不证明自然度。中文 MOS、人工偏好及实体设备 / AEC 仍需独立验收。

本轮通过 296 项相关 TypeScript 回归、11 项下载 / 校验测试、3 项 Python 神经语音协议测试，以及类型、Lint、架构、生成文档与桌面构建检查。5 项静音桌面回归覆盖自然音色选择 / 保存 / 试听、既有配置重启、PCM 实时回复及连续对话；另通过真实 Qwen 模型的 Worker → AudioHost 集成（7.6 秒），未注入模拟 TTS，也未打开麦克风或实际发声。可显式复现：`JOJO_E2E_NEURAL_REAL=1 pnpm --filter @desktop-agent/desktop exec playwright test -c playwright.electron.config.ts e2e/neural-voice-local.spec.ts`。它验证开发构建的真实运行链路，不替代签名安装包与实体扬声器验收。

明确的“请朗读 / 读给我听 / 给我念一首英文诗和一首中文诗 / 念两首诗 / 开始念 / 继续念 / 念吧 / read aloud”属于独立的本轮授权，文字输入与语音输入都适用。Worker 只检查顶层用户请求，忽略引用示例、翻译、功能讨论、第一人称叙述、否定及定时朗读请求；不依赖 `autoReadReplies`，也不修改它。客户端会在精确 final 回执上携带 `requestedReadAloud`，按完整正文朗读，跳过两句摘要与可选摘要模型。全文请求、手动“朗读”及“继续朗读”统一使用 `complete: true`：首段最多 80 字，完成即开播；Main 按消费进度预取后续片段，AudioHost 在同一 WebAudio 时间线上拼接，最多保留 3 个未消费片段。生成慢于播放时允许等待后续片段，只有最后一段实际结束才确认整篇 played。停止、切换会话、禁用语音或开始录音可取消准备和播放。语音未启用时打开开关并保存即可，不要求先录音或试听。模型在每个 Desktop Run 得到当前 TTS 启用状态，以本轮状态覆盖历史中的“未启用”说明；明确朗读时按请求顺序输出各篇原文，省去开场白、结束点评及“已交给客户端播放”的说明，也不能提前宣称播放成功。远程 Channel 不注入本机播放能力。

普通文字提问保持文字回复，启用语音或保存 `autoReadReplies=true` 都不会自动展开朗读状态或发起合成。设置中的开关明确标为“语音输入后自动朗读回复”；Worker 仅为来自语音输入的最终回执附加 `voiceInput`，Renderer 在此标记与开关同时成立时才自动朗读。缺失来源标记时保持静默。文字输入明确要求朗读、手动点击“朗读”以及主动启动的语音交流仍按原授权执行；普通文字任务的审批也不自动播报。正常取消朗读时清空停止提示，空闲输入框不保留“朗读已停止。”；模型不可用或合成失败等实际错误仍可见。

离线 Electron 用例 `e2e/explicit-read-aloud.spec.ts` 同时使用短词和“给我念一首英文诗和一首中文诗”复验：关闭自动朗读时仍完整读取正文；正文尚未全部准备完毕时即开始播放，始终只有一个 playbackId 和最终 played；成功准备的 `preparedChars` 覆盖规范化正文。随后在设置中开启语音输入后的自动朗读，文字输入“今天天气”，确认没有新增合成、播放或语音状态。`voice-conversation.spec.ts` 覆盖手动一键朗读、重复段落缓存复用及文字任务审批保持静默；`neural-voice-local.spec.ts` 显式使用真实 Serena 模型和静音 AudioHost 验证相同链路；`speech-read-failure.spec.ts` 使用实际缺失的运行环境验证开播前失败，并显示干净的神经语音提示。本次来源策略变更通过 275 项相关 TypeScript 测试、6 项隔离 Electron 流程，以及类型、Lint、架构、生成文档和桌面构建检查。

全文准备期间，神经模型的受控生成失败或生成超限会将当前实际文本长度减半重试，最小 50 字、最多两次；缺失环境和取消不重试，也不换声音或引擎。失败片段不会发布为 ready。错误区分模型加载、生成超限、推理失败及系统音色问题，不再向神经音色用户提示安装 macOS 系统声音，也不显示 Electron 的 remote-method 包装。`requestedChars` 包含失败尝试，不能作为成功覆盖的证据；完整朗读另按成功 ready 的正文长度累计 `preparedChars`，核对偏移连续后才允许播放。2026-10-18 的整篇合并实现曾遇到一次生成失败并在开播前恢复；当前滚动实现只重试尚未发布的片段，已播放内容不重播。上述时延表是此前中文单段的基准，不作为本次多语言长文的时延指标。

2026-10-18 整篇合并阶段通过 15 个文件 / 396 项相关 TypeScript 测试、5 项 Python 协议测试、类型、Lint、架构、生成文档与桌面构建检查。8 项隔离 Electron 流程全部通过，覆盖明确请求、多语言全文、手动一键朗读、实时语音、自动端点、录音恢复、缺失模型的错误提示及真实 Serena 模型。真实模型末次复验准备 467 个规范化字符、3 个源音频片段，正文音频共约 73.84 秒；合并后只有一次 played，播放开始与结束时合成请求数相同。真实模型未用模拟 TTS，AudioHost 音量为零，未打开麦克风或实际发声；这证明完整播放链路，不作为主观自然度验收。

`VoiceDeliveryLedger` 通过 Worker 的 `SqliteVoiceDeliveryStore` 写入 `speech.sqlite` 的独立表，保留最近有界记录。TTS ready / PCM 入队不等于听完；完整 segment 的 Worklet ACK 才计入 heard prefix。重启后未确认的片段标记 cancelled / interrupted，不自动重播。下一轮语音请求在 Provider 边界投影被打断的 assistant 正文，屏幕上的完整历史不变。手动全文朗读只在整段 AudioHost ended 后标记 played，中途停止不会假称已听完；自动摘要没有指向完整正文的伪续读偏移。

实验实时对话占用输出期间，排队的提醒等待交互结束并继续遵守有效期；已经播放的普通资产若被更高优先级语音打断，只能记 interrupted。审批仍使用固定安全短句，不能因为声音已播放就授权业务操作。提醒音频继续使用现有持久 Outbox / AudioHost，不把流式 TTS 的生成完成误作提醒投递成功。

本机基准执行：

```bash
pnpm speech:benchmark --iterations 2
```

该命令不播放、不录音、不下载、不改设置，固定文本只在合成内存 / 私有临时 WAV 中使用。2026-10-17 Apple M4 Pro / macOS arm64 的 16 次请求测得 warm first PCM P50 **1017 ms**、P95 **1244 ms**，RTF P95 **0.516**，取消约 **1.34 ms**。这是 say 完整句合成后输出 PCM 的耗时，不能当成整条 TTFA。子进程资源按 50 ms 采样，可能漏掉瞬时峰值。中文 MOS、韵律连续性、混合发音评分、M1 Pro 及主要输入输出设备组合均待实测；生产 TTS 保持 macOS say。[完整数值报告](./voice-benchmark-2026-10-17.json)。

### P3：本地 TTS 候选实测

新增 `SherpaTtsCandidate` 与 `speech-sidecar/tts_candidate.py`，仅由评测 CLI 显式使用，尚未接入生产 Provider 工厂或设置页。复用已有 NumPy / sherpa-onnx 环境，以 CPU、2 个 ONNX 推理线程运行 [MeloTTS 中文 / 英文 int8 作者模型](https://huggingface.co/csukuangfj/vits-melo-tts-zh_en/tree/a0d5c6a264c0ef92d70d8661d8cc502d79627cd6)。19 份模型、词典和规则文件固定在同一提交，逐份验证长度及作者 SHA256 / Git blob 摘要后原子发布；重跑离线检查复用完整目录，下载失败保留原目录。总计 **74,334,003 bytes**，模型文件 **53,517,430 bytes**，不安装 PyTorch。

```bash
pnpm speech:setup:tts
pnpm speech:setup:tts --download
pnpm speech:setup:tts --install-runtime
pnpm speech:benchmark --provider sherpa-melo --iterations 2 --report /absolute/new-melo-report.json
pnpm speech:benchmark --provider say --iterations 2 --report /absolute/new-say-report.json
```

第一条只离线校验；下载和安装须分别显式选择，需要时加 `--proxy http://127.0.0.1:PORT`。下载针对中断至多重试一次，每次传输有大小和时间上限，最终仍须精确摘要一致。评测前重新核验全部文件，可用 `--python` / `--model-dir` 指向已有路径；`--report` 只创建新文件，不覆盖已有报告。输出只含固定语料的类别、数值和模型摘要，不保留合成音频或用户正文，不采集麦克风、不播放、不改用户配置。

Python 模型进程跨轮复用。文字通过有界 stdio 二进制协议送入，不放在进程参数或环境变量中；模型原生 44.1 kHz 音频通过 48-tap windowed-sinc 重采样成 24 kHz PCM16 mono。当前适配等待完整音频再交给既有会话 API，因此 `textStreaming`、`audioStreaming`、`wordTimings` 均为 false。[sherpa 1.13.8 VITS 实现](https://github.com/k2-fsa/sherpa-onnx/blob/v1.13.8/sherpa-onnx/csrc/offline-tts-vits-impl.h)中的回调按句子批次产生；回调时刻单独记录，不能作为客户端首 PCM 或播放启动。取消等待实际推理子进程退出、丢弃未交付音频，下一轮重新加载模型；崩溃、错误帧和超时不返回伪完成。

2026-10-17 在 Apple M4 Pro / macOS arm64 上，同一套 8 类固定文本各跑两轮，首次请求包含进程启动与模型加载；warm 分位数使用其余 15 次，RTF 使用 16 次请求的生成耗时 / 实际音频时长，无单位。随后在长句提交 50 ms 后取消，并验证取消后无残余 PCM、下一轮可重新合成。以下是当前完整句适配器的实测，并非模型所有运行方式的性能结论：

| 指标 | macOS say | sherpa MeloTTS int8 |
|---|---:|---:|
| 首次请求到首 PCM | 1174 ms | 2351 ms |
| warm 首 PCM P50 / P95 | 1033 / 1129 ms | 4904 / 16708 ms |
| RTF P50 / P95 | 0.134 / 0.545 | 0.809 / 1.198 |
| 取消耗时 | 0.94 ms | 6.92 ms（实际推理中取消） |
| 取消后下一次首 PCM | 1040 ms | 2278 ms（重新加载） |
| 采样子进程峰值 RSS | 38,010,880 bytes | 591,167,488 bytes |
| 外置模型与词典大小 | 0 bytes | 74,334,003 bytes |

[Melo 实测报告](./voice-melo-benchmark-2026-10-17.json)记录固定版本全部文件的 SHA256、原生句子回调及两个实际模型进程；[say 同脚本复测报告](./voice-say-comparison-2026-10-17.json)保留对应请求数值。资源仅采样直接子进程，不包括 macOS 共享语音服务；CPU 可超过 100%，也可能漏掉瞬时峰值。Melo 尚未打入应用，应用安装包增量为 null；外置模型大小不等同于应用增量。RTF 会受两种声音语速差异影响，应结合首 PCM 和总耗时判断。

当前 Melo 完整句适配在本机的延迟更高，**不替换生产 say**。中文 MOS、混读发音、跨段韵律及实体设备听感仍为 null，Gate C 尚未验收；后续 CosyVoice 准备与评测见下节。Melo 阶段的 18 个文件 / 234 项相关 TypeScript 测试、14 项离线安装回归及 venv 中全部 21 项 Python 协议 / DSP 回归通过，覆盖跨轮复用、取消等待退出、重启恢复、帧乱序 / 身份校验、无音频失败、校验失败保留旧目录、重采样时长与混叠抑制。

共用协议增加二进制输出 body 后，现有中文参考 WAV 的 Paraformer / Smart Turn 两轮真实回放仍正常，每轮均有 7 次 partial、唯一非空 final 和真实自动端点；这是非实时参考样本，不能作为中文实录验收。3 项隔离 Electron 回归覆盖紧凑语音菜单、实时 PCM 回复、自动端点及损坏轮次恢复，均通过。TypeScript、ESLint、架构、文档一致性、桌面构建与空白检查通过；未打开实体麦克风或修改实际用户配置。

### P3：CosyVoice3 CPU 候选

CosyVoice 使用独立的 `.local-speech/venv-cosyvoice`（Python 3.11），与默认 ASR / sherpa 环境分开。新增 `speech:setup:cosyvoice`、固定模型 / 源码清单、大文件续传与只提取清单内常规源码的校验器。默认只做离线摘要检查；只有显式安装才在该 venv 中安装 PyTorch，显式下载才准备约 **5.43 GB** 推理文件。失败保留 `.part`，后续运行从已有长度继续；不匹配的完整文件隔离保存，全部校验通过后才原子发布模型目录。

```bash
pnpm speech:setup:cosyvoice
pnpm speech:setup:cosyvoice --install-runtime
pnpm speech:setup:cosyvoice --download
pnpm speech:benchmark --provider cosyvoice3 --iterations 1 --report /absolute/new-cosyvoice-report.json
```

需要本机代理时在准备命令后加 `--proxy http://127.0.0.1:PORT`。本次模型固定为 [Fun-CosyVoice3-0.5B-2512](https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512/tree/29e01c4e8d000f4bcd70751be16fa94bf3d85a18)，只取 CPU 推理需要的基础权重 / 词表 / ONNX，跳过 RL、TensorRT 和重复 batch tokenizer 权重，共 **5,427,041,134 bytes**。源码固定为 [CosyVoice 074ca6d](https://github.com/FunAudioLLM/CosyVoice/tree/074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc) 及其引用的 [Matcha dd9105b](https://github.com/shivammehta25/Matcha-TTS/tree/dd9105b34bf2be2230f4aa1e4769fb586a3c824e)。源码文件逐个 SHA256 核验；大权重使用作者 LFS SHA256，普通文件使用对应 Git blob 摘要。所需版本及传递依赖记录在 `scripts/cosyvoice-macos-py311.lock.txt`；固定构建工具保留旧 Whisper 使用的 `pkg_resources`，Diffusers 使用经导入验证的 0.31.0 以兼容当前 Transformers / Hub 组合。

`cosyvoice_candidate.py` 显式选择 CPU / FP32、2 个推理线程，禁用 TensorRT / vLLM；Matplotlib 使用无界面后端与私有评测缓存。参考声音由系统 say 合成固定中文句子并保存在忽略目录，报告记录其 SHA256；不采集个人录音。模型及参考提示在同一进程中复用，取消等待进程退出，下一次请求重新加载。模型实际生成的 24 kHz PCM 批次立即送入二进制管道，同时记录客户端收到首批 PCM 的时刻。

当前公开会话仍通过完整 WAV 适配器消费，因此会话的三项 streaming / word timing capability 继续为 false。报告分开提供原生批次的 `firstNativePcmMs` / `nativePcmWarmFirstMs` 和 WAV 适配后的 `firstPcmMs`，不把原生输出能力标成已经接入 Renderer 的流式播放。单次准备或合成失败输出明确失败状态、失败类别及已有数值观察，聚合指标为 null；报告仍不保存文字或音频，不覆盖已有文件。

模型与源码已通过本机完整校验、CPU 架构导入及配置加载。Apple M4 Pro / macOS arm64 下，以 CPU / FP32 / 2 线程完成同一套 8 类文本各一次，再在长句提交 50 ms 后取消并验证重载恢复。warm 指标来自首次请求以外的 7 次；RTF 来自全部 8 次请求，包含首次加载。首次请求在校验文件后启动新模型进程，不代表清空系统文件缓存的冷机测试。

| 指标 | 本次 CosyVoice3 CPU 实测 |
|---|---:|
| 首次原生 PCM / WAV 适配后首 PCM | 17,379 / 23,035 ms |
| warm 原生首 PCM P50 / P95 | 9,962 / 11,911 ms |
| warm WAV 适配首 PCM P50 / P95 | 19,241 / 149,352 ms |
| RTF P50 / P95 | 2.780 / 8.595 |
| 取消并等待进程退出 | 154.8 ms |
| 取消后重载到 WAV 首 PCM | 21,048 ms |
| 直接子进程采样峰值 RSS | 7,298,875,392 bytes |

[完整成功报告](./voice-cosyvoice3-cpu-benchmark-2026-10-18.json)包含全部请求、原生批次到达、模型与 93 份源码文件的摘要、参考声音摘要及实际启动的两个模型进程。`nativeSentenceCallbacks` 是沿用 Melo 报告的字段名，在 CosyVoice 中记录的是生成音频批次；不代表句子或逐词对齐。取消发生在当前推理请求进行中，确认取消后无音频交付；未播放声音，因此不是声学停播或自然插话验收。最初一轮在创建参考声音时因 UUID 请求校验失败而中止，[预备失败记录](./voice-cosyvoice3-benchmark-2026-10-17.json)保留为独立报告，没有模型推理指标；已修正并增加真实 macOS Provider 校验路径的离线回归。

当前 CPU 配置的原生首音较慢，RTF 大于 1；即使直接消费原生批次，也尚不满足实时对话要求，**不替换系统 say**。这是本次配置的结果，不外推为所有 Apple Silicon / MPS / MLX 后端的性能。主观中文 MOS、混读、跨段韵律与实体设备听感仍为 null；候选尚未打入应用，应用包增量仍为 null，Gate C 未验收。CosyVoice 的 PyTorch、依赖与模型均留在独立忽略目录，默认 ASR 环境、用户配置和输入框交互不变。

本轮 19 个文件 / 241 项 TypeScript 相关回归、21 项 Node 安装 / 续传回归、24 项 Python 协议 / DSP 回归与 3 项源码提取测试通过，覆盖逐批 PCM 交付、空结果 / 异常不伪完成、取消 / 重载、请求 UUID 与引用音频完成性、断点恢复、摘要失败保留旧输出、源码路径 / 链接 / 重复项拒绝。准备与 benchmark 的默认路径均不录音、不播放、不改设置。

Sidecar 的本地入口是 `apps/desktop/src/worker/speech-sidecar/main.py`，参数包括 `--vad-model`、`--paraformer-dir`、`--smart-turn-model`、`--vad-stop-secs 0.2` 和 `--pre-roll-ms 400`。Worker 将审核过的 Python 资源随构建打包，只在主动录音时写入私有、按内容版本隔离的运行目录并启动。stdout 是二进制协议，所有库日志重定向 stderr；可用 `createSpeechSidecarHost()` → `start()` 读取 capabilities。Smart Turn 仅在提供本地模型后加载 ONNX Runtime / WhisperFeatureExtractor，缺依赖时能力不可用，未引入默认 PyTorch/FunASR 路线。

`streamingInput` 为可选配置：`enabled`、`vadModel`、`paraformerDirectory`、可选 `smartTurnModel`、`autoEndpoint`（缺省 false）与 `fallbackTimeoutMs`（缺省 3000，配置范围 500–10000），共用 `provider.asr.local.pythonPath`。改变输入引擎或模型配置会撤销先前验证；保存禁用配置、主动测试转写和试听后才能重新启用。`StreamingSpeechAsr` 把每个请求绑定独立 capture / turn / generation；只有上游 EOF、PCM 消费完成、sidecar finish 和唯一 final 全部成立才创建草稿。partial 不调用 Agent。Sidecar ACK 到达后才释放上传信用，取消不会等待卡住的上游；断链或关闭超时会弃用进程，后续显式录音可重新构造。

自动端点是显式实验选项：须有可加载的 Smart Turn，缺失时在 ready 前报不可用，不静默改成另一套识别器。VAD stop 基线 0.2 秒后直接做 Smart Turn 判定；complete 立即发送带本轮句柄的 endpoint 请求，不叠加固定等待；incomplete 继续收音并启动超时，恢复说话取消超时。推理异常仅报告 `turn.unavailable`，保留 ASR 并允许静音超时或手动结束。Worker → Main → Renderer 层层核对身份；Renderer stop Capture Worklet、排空残余 PCM 并发 end；Worker 看到 EOF 后才调用 sidecar finish 并发布最终草稿。停止和旧 generation 均清理端点计时器，重复 endpoint 不重复停麦或提交。`autoEndpointVerified` 发布验收标记仍为 false；实验开关不替代中文实录验收。

连续对话通过输入框工具栏麦克风旁的“语音选项”菜单，选择“开始连续对话”显式开启，不持久化启动授权。普通文字交流时不显示连续对话控制行和录音操作说明，启用语音配置也不会展开它们；菜单打开不会开始录音，支持方向键导航和 Esc 收起。开始连续对话后才展示静音、结束和操作提示，结束后恢复紧凑工具栏。

每轮最多 60 秒；默认点击“结束录音”，实验自动端点开启时可由模型结束。校正模式等待用户发送，自动发送模式仅提交 final。只有当前录音对应的 Run 完成、所有声音及全文续读片段结束后才重开麦克风。提交回执核对 voiceTurnId / generation，终结与回复核对 runId，传统播放再绑定 reply.messageId；旧任务的延迟事件不能结束新录音或触发重新收音。静音释放麦克风，恢复需用户点击；Esc 结束，Cmd/Ctrl+Shift+M 切换静音，120 秒空闲结束。切换会话、关闭语音、打开设置、锁屏、睡眠、设备变化和页面离开都会终止会话，解锁不自动恢复。结束或静音时保留输入框文字并解除已取消的语音草稿关联，之后仍可作为文字发送。任何停止声音或收音动作均不取消 Agent Run。

连续对话的单轮 `invalid_audio` / `empty_result` 现会进入可见的重新收音状态：立即释放麦克风并丢弃本轮，在 1 秒后重新检查当前会话、语音开关、任务和输入草稿，再创建新的 capture / generation。只允许连续自动重录两次，再失败就静音，须点击“恢复收音”才继续。有效 final 或显式恢复会重置次数；重录不延长原有空闲期限，也不把 partial 或损坏录音提交为任务。授权、模型不可用、设备故障、初始化 / 识别超时及其他协议错误停止会话，不自动重试。普通主动录音仍显示本轮错误，由用户重录。

收音创建和失败通过本地回调携带完整 captureId / voiceTurnId / generation；结束后的旧错误、旧 final 和旧 start Promise 不能影响新一轮。连续控制器先绑定 capture，再接受 final；进入校正或等待 Run 后，识别器的延迟清理不会结束当前任务。通道错误沿普通 Recorder 和共享 AudioGraph 保留 `invalid_audio` 代码，设备断开等未分类故障不会误入重录流程。停止、静音、会话 / 设置 / 设备变化、锁屏和睡眠都会撤销待重录计时器。用户在等待重录时主动点麦克风，则由新录音接管，不会再被自动计时器替换。

`e2e/voice-recovery.spec.ts` 在真实二进制通道制造三轮序号中断，验证 Main / Worker 返回正常失败、麦克风全部释放、前两次自动重录、第三次静音、三轮均无 final 草稿和 Agent Run，以及显式恢复后正常识别、发送、播放并开始下一轮。没有注入伪造的 Renderer 成功事件。本次恢复相关 18 项新增单测与既有身份 / 生命周期测试通过；Speech、Renderer 音频 / 连续会话、Worker 和 Main 共 21 个文件 / 360 项相关回归通过。5 项隔离 Electron 用例通过，包括恢复、自动端点、完整朗读、实时输出和传统语音对话。TypeScript、ESLint、架构检查和桌面构建通过；未使用实体麦克风或改写实际用户设置。该恢复策略提升半双工连续会话的可恢复性，仍不替代 P7 中更长期音频流的细粒度 gap tolerance，也不开放 AEC / 扬声器插话 Gate。

模型准备与检查：

```bash
pnpm speech:setup --streaming-sidecar
pnpm speech:setup --streaming-sidecar --download-streaming-models
pnpm speech:setup --streaming-sidecar --install-smart-turn-runtime
pnpm speech:smoke:streaming --wav /absolute/fixture.wav --python /absolute/python3 --vad /absolute/silero_vad.onnx --paraformer /absolute/StreamingParaformer
pnpm speech:smoke:streaming --wav /absolute/fixture.wav --auto-endpoint --smart-turn /absolute/smart-turn-v3.1.onnx
```

第一条只做离线真实进程 probe，不安装、不下载、不改配置。第二条显式下载约 237 MB 的 Silero 和固定作者版本 int8 Paraformer，校验 encoder / decoder SHA256 后才原子发布；可用 `--install-streaming-runtime` 显式准备 Python 依赖。`--install-smart-turn-runtime` 额外安装已验证 Python 3.9 的固定 `onnxruntime==1.19.2` / `transformers==4.49.0`，不引入 PyTorch。模型仍仅使用本地文件；有代理时可追加 `--proxy http://127.0.0.1:PORT`。两条 smoke 命令按 ACK 回放 16 kHz mono PCM16 WAV，默认同一 provider 两轮并输出数值耗时；`--auto-endpoint` 追加至多 2 秒静音并等待真实端点，未产生端点则有界超时报错。默认不打印转写，`--expected-text` 仅报告匹配布尔值，`--show-text` 才打印全文。这是非实时样本回放，不代表现场 TTFA。

2026-10-17 已通过本机系统代理完成 Paraformer / Silero 官方模型下载，两份 int8 ONNX 的 SHA256 与固定版本一致，真实进程 probe 的 `vad` 与 `streamingAsr` 均为 available。此前直连超时由下载脚本未使用系统代理导致；需要代理时显式追加 `--proxy http://127.0.0.1:PORT`，端口取本机实际配置。随后以现有 5.592 秒中文 WAV 完成同一 provider 两轮真实识别，每轮均返回 7 次 partial 和唯一非空 final；首次与复用轮总耗时约 879 / 183 ms。[输入模型校验与数值记录](./voice-input-smoke-2026-10-17.json)保留了当时尚无 Smart Turn 运行依赖的历史状态。与当前代码匹配的 [Smart Turn v3.1 CPU 固定版本](https://huggingface.co/pipecat-ai/smart-turn-v3/blob/16c8130e06d3af59663be3fd7c9ac80624850e6c/smart-turn-v3.1-cpu.onnx)已下载，8,679,180 字节且官方 SHA256 校验一致。

本轮补齐了 ONNX Runtime / Transformers，三项 capability 均真实可用；未安装 PyTorch。两轮真实自动端点回放中，Smart Turn 均输出 complete，分数约 0.985，模型推理分别约 131 / 104 ms，端点后只有排空音频才返回唯一 final。该测试没有按实时速度回放，只有一个中文样本，也未核对人工转写，因此不能当成现场 TTFA、中文停顿准确率或 AEC 验收。实验自动端点可显式选择，默认仍手动，自动端点发布验收与扬声器插话 Gate 仍为 false。[自动端点真实测试记录](./voice-endpoint-smoke-2026-10-17.json)。依赖安装和测试没有更改用户的语音配置。

中文语料入口现为 `pnpm speech:eval:turns --check` 和 `pnpm speech:eval:turns --run`，使用与桌面相同的输入 Provider；支持私有目录清单、完整 WAV SHA256 绑定人工标注、真实速度 200 ms 帧回放、停止后的 PCM 排空，以及提前截断率、漏端点率、端点延迟 P50 / P95 和负例误端点率。模型启动不计入音频时钟，推理 / 背压计入；模型错误不会记作漏端点。仅聚合已同意、环境信息完整的中文目标设备实录，参考或合成声音不进入发布指标。配置门槛为 null 时明确阻止验收，数值满足也只返回待人工核验的结果，不改任何发布开关。操作、标注与统计定义见[语料说明](../../tests/fixtures/speech/README.md)。

2026-10-17 已实跑[缺项检查](./voice-turn-corpus-check-2026-10-17.json)：13 条实录仍缺失，六类提问场景必需，门槛未配置。另以已有 5.592 秒官方中文参考录音完成[真实速度模型回放](./voice-turn-reference-replay-2026-10-17.json)，Smart Turn 端点在音频时钟约 5.749 秒到达，随后得到唯一 final，最大帧迟到约 1.3 ms。该样本没有人工端点标注，故端点延迟和准确率均为 null；不是本机实录，不进入实录分母。这两个报告的 blocked 是缺少验收材料的预期结果，不代表模型进程失败。本次新增 31 项离线测试通过，覆盖计分边界、来源隔离、标注漂移、观察窗不足、中文文件名、符号链接越界、排空和错误分类；Speech 包与桌面输入 / voice tasks / smoke 共 15 个文件、256 项回归通过。TypeScript、ESLint、架构检查及文档一致性检查通过。

`e2e/realtime-voice.spec.ts` 以合成麦克风和静音 WAV 验证生产 Main / Worker / Preload / Renderer / Worklet 链路及已听 ACK。新增 `e2e/auto-endpoint.spec.ts` 验证录音无需点击结束便自动停麦、endpoint → 排空 / recognizing → review 的事件顺序、校正模式不隐式提交、播放后下一轮，以及结束会话后保留文字可继续发送。模型在 E2E 中由显式离线 Provider 代替；它证明控制和数据路径，不替代上面的真实模型测试、实体 AEC 或主观音质验收。Gate A–E 仍应按 v2 文档在实际设备与中文录音集上完成验收后再扩大默认配置。

2026-10-17 本轮验证：全仓 Vitest **264 个文件 / 2164 项通过，3 项按既有条件跳过**，包含连续会话身份 / 乱序 / 生命周期 13 项及自动端点协议回归；需要本机端口的用例在沙箱外执行。4 项 Electron 用例通过，其中自动端点用例覆盖两轮、停麦与排空顺序、校正与发送、结束后文字发送；实时语音用例继续验证 track 释放、静音 / 恢复及 Esc 结束。离线 setup 23 项及 Python 协议 / 生命周期 14 项通过。此前语音 / AudioHost / 历史兼容用例的验证记录保留。TypeScript、ESLint、架构约束、38 项操作绑定、生成文档一致性及 diff 空白检查通过。验证期间没有打开实体麦克风、播放真实合成声音或改写用户的实际语音配置；端到端用例使用隔离数据目录。

streaming smoke 的 14 项离线回归单独通过，新增自动端点截取与无端点超时用例；缺失模型场景实测明确返回 `local_unavailable`，真实 Paraformer / VAD / Smart Turn 冒烟结果见上文。默认链路真实冒烟也通过：官方本地中文 WAV 经 SenseVoice 得到 14 字 final，系统 TTS 生成完整 24 kHz WAV（149850 字节），未播放。两条链路的样本冒烟不能代替真实中文端点评测。

桌面链路包含按键录音、实验自动端点、半双工连续对话、转写校正 / 自动发送、Run 去重、最终助手正文朗读、独立 AudioHost、音色预设及试听、审批固定短句、长回复继续朗读、缓存清理和本次启动统计。Scheduler 支持纯提醒 Target、持久 Delivery Outbox、任务结果播报、系统通知和显式托盘常驻，详见 [Durable Scheduler](./scheduler.md)。中文端点默认发布 / 自然插话以及硬件、通知与签名包实机验收仍待完成。

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

旧语音配置在持久配置读取边界归一化：全本地配置保留开关、模型路径、语言、系统声音和偏好，并清除旧协议 / 资源字段；使用旧云端服务的配置转为禁用的本地配置，可在语音设置中重新开启并保存。切换到系统朗读时，旧云端音色恢复为 `default`。文字模型、权限、记忆及其他配置继续保留。新语音 Schema 严格拒绝云端服务、Key 和任意 endpoint；兼容迁移不开放新的云端运行入口。

语音设置页移除“显式验证”及启用前置说明。填写 Python 与模型路径、勾选“启用语音”后保存即可生效；Main 不再要求录音和试听证明，切换音色或引擎也保留启用状态。保存不会打开麦克风、运行识别、加载神经模型或播放音频；模型与依赖不可用时，在实际使用时显示错误。“试听声音”和预设试听均为可选操作。主输入框的麦克风仍需主动点击才开始录音。 本次取消前置验证后，通过 180 项相关回归、7 项静音桌面流程及 1 项真实离线模型集成；首次启用保存后的 ASR / TTS 请求数均保持 0，配置在重启后保留。

`voicePresets` 最多 20 项，ID 唯一；每项保存 `id`、`name`、`speakerId`、`speechRate`，只覆盖系统声音与语速。预设修改后先保存再试听，试听不作为启用语音或保存配置的前置条件。删除预设后，关联任务须重新选择并保存。

## 音频缓存和所有权

`SpeechService` 先规范化可朗读文字，再计算缓存键。键包含文字 hash、实际 `tts.id`、speakerId、speechRate、format、sampleRate、文字规范化版本和适配器协议版本；不同系统声音参数不能复用彼此的音频。音频事件及缓存资产的格式、采样率必须匹配当前 TTS 配置。账号凭据不进入缓存键，也不落入音频 manifest。

可选“试听声音”使用 `forceProvider=true`，每次跳过 ready 缓存查询并调用当前所选 TTS 服务；页面不展示“已验证 / 待验证”状态，也不据此阻止启用或保存。底层仍记录真实成功请求供诊断使用，普通消息朗读继续复用缓存。

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

单条“朗读”接受 sessionId / messageId、可选规范化正文 offset 和 `complete`。Worker 重新读取持久会话中的助手纯文本，排除 tool_call / internal 消息，确定性整理 Markdown。本地合成每段最多 200 个 Unicode 码点，预算内优先在句末、短句或词间结束；续读 offset 按实际成功长度计算，包含分隔符，不丢失或重复正文。`complete: true` 时 Main 在准备阶段遍历所有 offset、核对正文长度及资产归属，全部完成后才入队；任一段失败则整篇不出声。语音输入后的自动回复仍只读短摘要，禁止传入 complete 或非零 offset。全文仍在原会话，不另存语音正文；自动朗读只消费本轮 operation 的最终已提交消息 ID，跳过其他会话、录音期间和重复事件。停止声音不取消 Agent Run。

完整朗读最多 128 个源资产、合计 64 MiB，每个源资产仍遵守 8 MiB 上限。Broker 在开播前重新核对每个文件的归属、期限、大小和规范路径，严格解析 mono / 24 kHz / PCM16 WAV，再按顺序合并 PCM、重写唯一 WAV 头，经显式 complete 标记送入私有 AudioHost。普通声音桥仍限 8 MiB；合并后的声音只使用一个 Blob 和播放器，中途没有新的合成、IPC 接续或解码器切换。播放期限按实际音频时长计算，避免超过 5 分钟的正文被普通短句期限截断。取消准备不会在稍后出声；旧播放的延迟停止回执不会中断新的准备。连续对话也不把正在准备或播放的长文算作 120 秒空闲。

神经语音单次生成有 180 秒进程期限；Worker RPC 的 readMessage 期限为 550 秒，以覆盖最多三次实际尝试，试听为 185 秒，状态等普通请求仍为 45 秒。进程失败、关闭和用户取消均有明确结束路径；完整阅读的 Renderer 等待上限为一小时，未用无限等待掩盖失败。

用户主动开启“语音输入后自动朗读回复”后，仅在当前会话由用户提交的语音任务出现待审批操作时，播报一次固定短句“需要你确认一项操作，请在界面中查看并确认。”。普通文字任务保持静默；提交文字、任务结束或切换会话会清除本轮语音交互状态。Worker 在合成前后核对 sessionId / approvalId 仍待审批，关闭或切换审批会取消旧声音。播报不包含命令、文件差异或审批正文，也不会调用批准入口；授权仍由原审批 UI 和 Permission Governance 决定。

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

在 Jojo「语音设置」中填写安装器输出路径，勾选“启用语音”并保存即可使用。可按需点击“试听声音”，不再要求录音和试听测试。缺少模型、Python 依赖或系统音色时，在实际使用时显示不可用。

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
