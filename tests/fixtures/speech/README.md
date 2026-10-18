# 中文语音回放语料

`manifest.json` 同时保存 13 类待补录音和已有的合成事件轨迹。当前录音均为 `missing`。事件轨迹只检验控制顺序，不能证明模型准确率、回声消除或扬声器插话效果。

## 检查和回放

在仓库根目录执行：

```bash
pnpm speech:eval:turns --check
pnpm speech:eval:turns --run
pnpm speech:eval:turns --run --manifest /absolute/private-corpus/manifest.json --report /absolute/new-report.json
```

默认 `--check` 只检查清单、WAV 格式、哈希和标注，不加载模型。`--run` 才启动已有的本地 Silero / Paraformer / Smart Turn，通过桌面使用的 `StreamingSpeechAsr` 回放；同一进程跨录音复用。支持 `--python`、`--vad`、`--paraformer`、`--smart-turn` 和 `--fallback-timeout-ms`，模型路径缺省使用仓库 `.local-speech`。不录音、不播放、不下载、不修改桌面配置。

文件必须是完整的 **16 kHz、单声道、PCM16LE RIFF/WAVE，最长 60 秒**。WAV 路径相对清单所在目录，不接受 `..`、绝对路径或指向目录外的符号链接。最多 128 条记录；清单最多 256 KiB。私有录音可放在仓库外的独立目录，使用 `--manifest` 指定该目录内的清单；不必把声音提交到 Git。

结果输出 ID、文件 SHA256、时长、数值观测、指标和缺项，不输出路径、字幕、final 正文或音频。`--report` 额外写入一个新的本地 JSON 文件，不覆盖既有文件。脚本退出 0 表示显式数值标准满足，2 表示缺数据 / 未配置标准，1 表示输入或运行失败 / 标准超限；pnpm 可能把非零退出码统一为 1，应同时读取报告的 `assessment` 与各条 `status`。

## 接入实录与人工标注

取得说话者同意后，把 WAV 放入清单目录，设置该条 `status: "available"`。实录条目使用 `provenance: "target_device_recording"`、`consentConfirmed: true`、`language: "zh"` 和不含个人信息的 `environmentId`（例如 `mac-internal-quiet`）。没有同意标记的实录不会被读取。

先执行 `--check` 得到整份 WAV 的 `audioSha256`，再由人工标记最后一个有意继续说话的语音结束时间 `speechEndMs`，以及本条容许的 `maxLatencyMs`。这两个时间均以 WAV 起点为零。包含句中停顿的录音仍只标最终结束，不能把中途停顿标成一轮完成。每个文件对应一个录音轮次，不拼接多个独立提问。

条目示例（时间仅说明格式，不代表发布标准；哈希须替换成 `--check` 的实际值）：

```json
{
  "id": "01-normal-question",
  "wav": "01-normal-question.wav",
  "status": "available",
  "provenance": "target_device_recording",
  "consentConfirmed": true,
  "environmentId": "mac-internal-quiet",
  "language": "zh",
  "endpoint": {
    "kind": "turn",
    "audioSha256": "<实际 WAV 的 64 位小写 SHA256>",
    "speechEndMs": 4200,
    "maxLatencyMs": 1500
  }
}
```

录音必须延续到 `speechEndMs + maxLatencyMs`，保留真实尾部静音；观察时间不足会阻止计分。替换或裁剪 WAV 后必须重新核对标注和哈希，旧标注不能套用新声音。纯噪声等确实不应结束一轮的样本可标成 `endpoint: {"kind":"no_endpoint","audioSha256":"<实际哈希>"}`，整个录音作为观察窗。

外部参考录音和合成声音分别使用 `reference_recording`、`synthetic_audio`。它们可以回放并生成单条诊断，均不进入实录统计。未标注的录音可以诊断模型链路，但没有端点延迟或正确率分数。

## 指标与验收

回放按 200 ms 帧的结束时刻送入音频，启动模型的等待不进入音频时钟；推理、ACK 与背压耗时保留在观测内。端点出现后，排空截至停止时刻已采集的 PCM，再 EOF / final。报告同时保留端点到达时的音频处理位置、最终排空位置和最大帧迟到值，以便发现模型处理跟不上实时的情况。此测试测量本地文件回放，不包含实体麦克风、系统音频驱动或播放链路延迟。

只对有标注、已同意且环境和中文信息齐全的目标设备实录聚合：

- `prematureRate`：端点早于 `speechEndMs` 的轮次 / 有效提问轮次。
- `missedEndpointRate`：未收到端点或超过该条截止时间的轮次 / 有效提问轮次。提前截断单独计数，不重复归入漏端点。
- `latencyP50Ms` / `latencyP95Ms`：端点到达时间减去 `speechEndMs`，仅聚合非负的已观测值，包含迟到端点；提前端点的负值保留在单条结果中。采用 nearest-rank 分位数。
- `falseEndpointRate`：`no_endpoint` 样本中出现端点的条数 / 有效负例条数。

无分母的指标为 `null`。模型不可用、进程断链、协议错误等记为 `error`，不会伪装成漏端点。参考 / 合成样本不能稀释实录错误率。

`endpointEvaluation.requiredIds` 当前要求 01、02、03、10、11、12 六类提问场景。04–09、13 仍供 backchannel、噪声、回声和重叠语音验证；本工具不判定说话者身份、不验证 Agent Run 数量，也不签发 AEC / 自然插话验收。

v2 设计没有给定 Gate D 的数值门槛，因此 `endpointEvaluation.thresholds` 保持 `null`，不会擅自宣告合格。确定项目验收标准后可配置 `maxPrematureRate`、`maxMissedRate`（0–1）、`maxP95LatencyMs`（正整数）和可选的 `maxFalseEndpointRate`。缺少必需实录、标注、指标覆盖或门槛时为 `blocked`；数据完整但超过门槛为 `thresholds_failed`；满足数值标准为 `criteria_met`。三者均不修改运行配置，`manualReviewRequired` 始终为 true，`enablesAutoEndpoint` 与 `certifiesAec` 始终为 false。

2026-10-17 的[语料缺项检查](../../../docs/technical-implementation/voice-turn-corpus-check-2026-10-17.json)和[单条官方参考录音的真实模型回放](../../../docs/technical-implementation/voice-turn-reference-replay-2026-10-17.json)已保存。后者没有人工标注，实录指标仍为空，不能用于 Gate D 放行。
