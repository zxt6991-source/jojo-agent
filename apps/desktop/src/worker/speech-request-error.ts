import { SpeechProviderError, type SpeechSettings } from '@desktop-agent/contracts';

/** Never forward provider bodies, Python diagnostics or Electron IPC wrappers. */
export function speechRequestError(error: unknown, engine?: SpeechSettings['provider']['tts']['id']): string {
  if (!(error instanceof SpeechProviderError)) return '语音请求失败，请重试或检查语音设置。';
  if (error.code === 'cancelled') return '朗读已停止。';
  if (error.code === 'local_unavailable') return engine === 'mlx-qwen3'
    ? '本机神经语音暂时不可用，请检查模型目录及 Python 运行环境。'
    : '本地系统朗读不可用，请确认使用 macOS 且已安装所选系统声音。';
  if (error.code === 'speaker_unavailable') return '所选音色不可用，请检查当前朗读服务和声音设置。';
  if (error.code === 'timeout') return '语音生成等待超时，请重试或缩短本次朗读内容。';
  if (error.code === 'synthesis_limit') return '本段语音生成超限，请缩短朗读内容后重试。';
  if (error.code === 'synthesis_failed') return '本机语音生成失败，请重试；已生成的片段不会作为完整朗读播放。';
  return '语音请求失败，请检查设置、录音或对话任务状态。';
}
