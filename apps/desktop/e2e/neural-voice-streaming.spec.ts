import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { SpeechEvent } from '@desktop-agent/contracts';
import { launchElectron } from './helpers/launch-electron';

test('real neural PCM reaches the desktop worklet and resumes after an interrupted turn', async () => {
  test.skip(process.env.JOJO_E2E_NEURAL_REAL !== '1', 'Explicit local model/GPU integration only.');
  test.setTimeout(180_000);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-neural-stream-'));
  const installation = path.resolve('../../.local-speech');
  const previous = process.env.JOJO_E2E_SPEECH;
  process.env.JOJO_E2E_SPEECH = 'input';
  let launched: Awaited<ReturnType<typeof launchElectron>>;
  try { launched = await launchElectron(directory); }
  finally { if (previous === undefined) delete process.env.JOJO_E2E_SPEECH; else process.env.JOJO_E2E_SPEECH = previous; }
  const { app, page } = launched;
  try {
    // Keep the real graph/ACK path active, while Electron mutes physical output.
    await app.evaluate(({ app, webContents }) => {
      webContents.getAllWebContents().forEach(contents => contents.setAudioMuted(true));
      app.on('web-contents-created', (_event, contents) => contents.setAudioMuted(true));
    });
    await page.evaluate(async local => {
      const { settings } = await window.desktopAgent.getSpeechSettings();
      await window.desktopAgent.saveSpeechSettings({ settings: { ...settings, enabled: true, autoReadReplies: true, realtimeReplies: true,
        provider: { ...settings.provider, tts: { ...settings.provider.tts, id: 'mlx-qwen3', speakerId: 'Serena', speechRate: 0, local } },
        streamingInput: { enabled: true, vadModel: '/e2e/input-only/vad', paraformerDirectory: '/e2e/input-only/asr' },
        playback: { ...settings.playback, volume: 1 }
      } });
    }, { pythonPath: path.join(installation, 'venv-mlx-tts/bin/python3'), modelDirectory: path.join(installation, 'models/Qwen3-TTS-0.6B-4bit') });
    await page.reload();
    await page.evaluate(() => {
      (window as any).neuralStreamEvents = [];
      window.desktopAgent.onSpeechEvent(event => {
        (window as any).neuralStreamEvents.push(event);
        if ((window as any).stopNextNeuralPlayback && event.type === 'playback' && event.state === 'playing') {
          (window as any).stopNextNeuralPlayback = false;
          void window.desktopAgent.stopSpeechPlayback({ playbackId: event.playbackId });
        }
      });
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
        const context = new AudioContext({ sampleRate: 48000 });
        const tone = context.createOscillator(), destination = context.createMediaStreamDestination();
        tone.connect(destination); tone.start(); await context.resume();
        const track = destination.stream.getAudioTracks()[0]!, stop = track.stop.bind(track);
        let stopped = false;
        track.stop = () => { if (stopped) return; stopped = true; stop(); tone.stop(); void context.close(); };
        return destination.stream;
      } });
    });
    await page.getByRole('button', { name: '新建对话', exact: true }).click();
    const outcomes = ['played', 'interrupted', 'played'];
    for (let turn = 1; turn <= outcomes.length; turn++) {
      await page.evaluate(stop => { (window as any).stopNextNeuralPlayback = stop; }, turn === 2);
      await page.getByRole('button', { name: '开始录音', exact: true }).click();
      await expect(page.getByText(/可以说话 · 1 \/ 60 秒/u)).toBeVisible();
      await page.getByRole('button', { name: '结束录音', exact: true }).click();
      await expect(page.getByPlaceholder('随心输入')).toHaveValue('E2E: text');
      await page.getByRole('button', { name: '发送消息', exact: true }).click();
      await expect.poll(async () => page.evaluate(() => ((window as any).neuralStreamEvents as SpeechEvent[])
        .filter(event => event.type === 'output_closed').map(event => event.outcome)), { timeout: 90_000 }).toEqual(outcomes.slice(0, turn));
    }
    const status = await page.evaluate(() => window.desktopAgent.getSpeechStatus());
    expect(status.latency?.metrics.ttsFirstPcmMs?.samples).toBe(3);
    expect(status.latency?.metrics.playbackStartMs?.samples).toBe(3);
    expect(status.playbacks.filter(state => state.state === 'played')).toHaveLength(2);
    expect(status.playbacks.filter(state => state.state === 'interrupted')).toHaveLength(1);
    // Real-time output bypasses full-WAV assets; a simulated provider would also
    // fail to materialize the bundled sidecar checked by the companion test.
    expect(status.diagnostics?.tts.requests).toBe(0);
    const report = { scope: 'real_Qwen3_MLX_Worker_MessagePort_AudioWorklet', syntheticAsr: true, syntheticLlm: true,
      physicalOutputMuted: true, turns: 3, outcomes, latency: status.latency };
    const reportPath = test.info().outputPath('neural-stream-latency.json');
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    await test.info().attach('neural-stream-latency', { path: reportPath, contentType: 'application/json' });
    console.log(`NEURAL_STREAM_LATENCY ${JSON.stringify(report)}`);
  } finally { await app.close(); }
});
