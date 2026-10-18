import { describe, expect, it } from 'vitest';
import { SpeechProviderError } from '@desktop-agent/contracts';
import { speechRequestError } from './speech-request-error';

describe('controlled speech failure messages', () => {
  it('describes the selected engine instead of sending neural users to system voice installation', () => {
    const error = new SpeechProviderError('local_unavailable', 'private Python traceback');
    expect(speechRequestError(error, 'mlx-qwen3')).toContain('神经语音');
    expect(speechRequestError(error, 'mlx-qwen3')).not.toMatch(/macOS|系统声音|traceback/u);
    expect(speechRequestError(error, 'macos')).toContain('系统声音');
  });
  it('keeps synthesis limits separate from installation and never forwards raw diagnostics', () => {
    expect(speechRequestError(new SpeechProviderError('synthesis_limit', 'private body'), 'mlx-qwen3')).toContain('生成超限');
    expect(speechRequestError(new SpeechProviderError('synthesis_failed', 'private body'), 'mlx-qwen3')).toContain('生成失败');
    expect(speechRequestError(new Error('private Python traceback'))).not.toContain('private');
  });
});
