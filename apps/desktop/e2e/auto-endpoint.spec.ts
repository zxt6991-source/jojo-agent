import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { SpeechEvent } from '@desktop-agent/contracts';
import { launchElectron } from './helpers/launch-electron';

test('automatic endpoint stops and drains capture, reviews final, and continues after playback', async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-auto-endpoint-'));
  const previous = process.env.JOJO_E2E_SPEECH; process.env.JOJO_E2E_SPEECH = '1';
  let launched: Awaited<ReturnType<typeof launchElectron>>;
  try { launched = await launchElectron(directory); }
  finally { if (previous === undefined) delete process.env.JOJO_E2E_SPEECH; else process.env.JOJO_E2E_SPEECH = previous; }
  const { app, page } = launched;
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.getByRole('button', { name: '新建对话', exact: true }).click();
    await page.evaluate(async () => {
      const { settings } = await window.desktopAgent.getSpeechSettings();
      await window.desktopAgent.saveSpeechSettings({ settings: { ...settings, autoReadReplies: true, realtimeReplies: true,
        streamingInput: { enabled: true, vadModel: '/e2e/vad.onnx', paraformerDirectory: '/e2e/paraformer', smartTurnModel: '/e2e/smart-turn.onnx', autoEndpoint: true } } });
    });
    await page.reload();
    await page.evaluate(() => {
      (window as any).endpointEvents = []; (window as any).microphones = 0; (window as any).startedRuns = 0;
      window.desktopAgent.onSpeechEvent(event => (window as any).endpointEvents.push(event));
      window.desktopAgent.onAgentEvent(event => { if (event.type === 'turn.started') (window as any).startedRuns++; });
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
        (window as any).microphones++;
        const context = new AudioContext({ sampleRate: 48000 }), oscillator = context.createOscillator(), destination = context.createMediaStreamDestination();
        oscillator.connect(destination); oscillator.start(); await context.resume();
        const track = destination.stream.getAudioTracks()[0]!, stop = track.stop.bind(track); let stopped = false;
        track.stop = () => { if (stopped) return; stopped = true; (window as any).microphones--; stop(); oscillator.stop(); void context.close(); };
        return destination.stream;
      } });
    });
    await page.getByRole('button', { name: '设置语音', exact: true }).click();
    const settings = page.getByRole('form', { name: '语音', exact: true });
    await expect(settings.getByLabel('自动结束录音', { exact: true })).toHaveValue('automatic');
    await settings.getByLabel('启用语音', { exact: true }).check();
    await settings.getByRole('button', { name: '保存语音设置', exact: true }).click();
    await expect(settings.getByText('所有设置已保存。', { exact: true })).toBeVisible();
    await expect(settings.getByLabel('转写服务', { exact: true })).toHaveValue('Paraformer · 本地实时识别');
    await settings.getByLabel('实时转写设置', { exact: true }).screenshot({ path: test.info().outputPath('auto-endpoint-settings.png') });
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await page.getByRole('button', { name: '语音选项', exact: true }).click();
    await page.getByRole('menuitem', { name: '开始连续对话', exact: true }).click();
    await expect(page.getByPlaceholder('随心输入')).toHaveValue('E2E: text');
    await expect(page.getByText('校正并发送后继续', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as any).microphones)).toBe(0);
    expect(await page.evaluate(() => (window as any).startedRuns)).toBe(0);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect.poll(async () => page.evaluate(() => ((window as any).endpointEvents as SpeechEvent[]).filter(event => event.type === 'output_closed' && event.outcome === 'played').length)).toBe(1);
    await expect.poll(async () => page.evaluate(() => ((window as any).endpointEvents as SpeechEvent[]).filter(event => event.type === 'endpoint' && event.purpose === 'conversation').length)).toBe(2);
    await expect(page.getByText('校正并发送后继续', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as any).microphones)).toBe(0);
    expect(await page.evaluate(() => (window as any).startedRuns)).toBe(1);
    const events = await page.evaluate(() => (window as any).endpointEvents as SpeechEvent[]);
    const endpoints = events.filter(event => event.type === 'endpoint' && event.purpose === 'conversation');
    expect(new Set(endpoints.map(event => event.type === 'endpoint' ? event.captureId : '')).size).toBe(2);
    for (const event of endpoints) {
      if (event.type !== 'endpoint') continue;
      const end = events.findIndex(item => item.type === 'capture' && item.captureId === event.captureId && item.state === 'recognizing');
      const final = events.findIndex(item => item.type === 'capture' && item.captureId === event.captureId && item.state === 'review');
      expect(end).toBeGreaterThan(events.indexOf(event)); expect(final).toBeGreaterThan(end);
    }
    await page.screenshot({ path: test.info().outputPath('auto-endpoint-review.png') });
    await page.getByRole('button', { name: '结束对话', exact: true }).click();
    await expect(page.getByRole('button', { name: '语音选项', exact: true })).toBeVisible();
    await expect(page.getByLabel('连续语音对话', { exact: true })).toHaveCount(0);
    // The retained text can still be sent after its voice-draft reservation was discarded.
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).startedRuns)).toBe(2);
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});
