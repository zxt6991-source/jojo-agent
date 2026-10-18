import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSpeechSidecarHost } from './speech-sidecar-host';
describe('local speech sidecar host', () => {
  it('probes missing models honestly without opening capture, downloading or starting a network listener', async () => {
    const client = createSpeechSidecarHost({ pythonPath: 'python3', scriptPath: path.resolve('apps/desktop/src/worker/speech-sidecar/main.py') });
    try {
      const capabilities = await client.start();
      expect(capabilities.vad.available).toBe(false); expect(capabilities.streamingAsr.available).toBe(false); expect(capabilities.smartTurn.available).toBe(false);
      await expect(client.open({ voiceSessionId: 'voice', turnId: 'turn', captureId: 'capture', generation: 1 })).rejects.toThrow('models are unavailable');
    } finally { await client.dispose(); }
  });
  it('rejects nonabsolute entry points and controlled Python path errors', async () => {
    expect(() => createSpeechSidecarHost({ pythonPath: 'python3', scriptPath: 'relative.py' })).toThrow('paths');
    const client = createSpeechSidecarHost({ pythonPath: '/unavailable-jojo-python', scriptPath: path.resolve('apps/desktop/src/worker/speech-sidecar/main.py') });
    await expect(client.start()).rejects.toThrow(); await client.dispose();
  });
});
