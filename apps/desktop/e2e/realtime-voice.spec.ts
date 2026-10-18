import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { SpeechEvent } from '@desktop-agent/contracts';
import { launchElectron } from './helpers/launch-electron';

test('opted-in voice Run uses PCM port and playback worklet with heard ACKs', async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-realtime-voice-'));
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
      await window.desktopAgent.saveSpeechSettings({ settings: { ...settings, autoReadReplies: true, realtimeReplies: true } });
    });
    await page.reload();
    await page.evaluate(() => {
      (window as any).realtimeEvents = [];
      (window as any).activeMicrophones = 0;
      (window as any).openedMicrophones = 0;
      window.desktopAgent.onSpeechEvent(event => (window as any).realtimeEvents.push(event));
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
        (window as any).activeMicrophones++; (window as any).openedMicrophones++;
        const context = new AudioContext({ sampleRate: 48000 });
        const tone = context.createOscillator(), destination = context.createMediaStreamDestination();
        tone.connect(destination); tone.start(); await context.resume();
        const track = destination.stream.getAudioTracks()[0]!, stop = track.stop.bind(track);
        let stopped = false;
        track.stop = () => { if (stopped) return; stopped = true; (window as any).activeMicrophones--; stop(); tone.stop(); void context.close(); };
        return destination.stream;
      } });
    });
    await page.getByRole('button', { name: '设置语音', exact: true }).click();
    const settings = page.getByRole('form', { name: '语音', exact: true });
    await settings.getByLabel('启用语音', { exact: true }).check();
    await settings.getByRole('button', { name: '保存语音设置', exact: true }).click();
    await expect(settings.getByText('所有设置已保存。', { exact: true })).toBeVisible();
    await expect(settings.getByLabel('实验：语音提问后边生成边朗读', { exact: true })).toBeChecked();
    await settings.screenshot({ path: test.info().outputPath('realtime-voice-settings.png') });
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await page.getByRole('button', { name: '开始录音', exact: true }).click();
    await expect(page.getByText(/可以说话 · 1 \/ 60 秒/u)).toBeVisible();
    await page.getByRole('button', { name: '结束录音', exact: true }).click();
    await expect(page.getByPlaceholder('随心输入')).toHaveValue('E2E: text');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.getByText('hello from offline e2e', { exact: true })).toBeVisible();
    await expect.poll(async () => page.evaluate(() => ((window as any).realtimeEvents as SpeechEvent[]).filter(event => event.type === 'output_closed').map(event => event.outcome))).toEqual(['played']);
    const events = await page.evaluate(() => (window as any).realtimeEvents as SpeechEvent[]);
    const available = events.find(event => event.type === 'output_available');
    if (!available || available.type !== 'output_available') throw new Error('No output capability.');
    expect(events).toContainEqual(expect.objectContaining({ type: 'session_run_finished', sessionId: available.sessionId, runId: available.runId, outcome: 'completed' }));
    expect(events.filter(event => event.type === 'reply' && event.runId === available.runId)).toHaveLength(0);
    const status = await page.evaluate(() => window.desktopAgent.getSpeechStatus());
    expect(status.playbacks).toContainEqual(expect.objectContaining({ playbackId: available.runId, state: 'played' }));
    expect(status.latency?.metrics.ttsFirstPcmMs?.samples).toBe(1);
    expect(status.latency?.metrics.playbackStartMs?.samples).toBe(1);
    await expect.poll(() => page.evaluate(() => (window as any).activeMicrophones)).toBe(0);
    await expect(page.getByLabel('连续语音对话', { exact: true })).toHaveCount(0);
    await expect(page.getByText('每轮点击结束录音 · 播放期间停止收音 · Esc 结束', { exact: true })).toHaveCount(0);
    await page.locator('.composer').screenshot({ path: test.info().outputPath('text-composer-voice-idle.png') });
    const voiceOptions = page.getByRole('button', { name: '语音选项', exact: true });
    await voiceOptions.click();
    await expect(page.getByRole('menu', { name: '语音选项', exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as any).activeMicrophones)).toBe(0);
    await page.screenshot({ path: test.info().outputPath('voice-options-menu.png') });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu', { name: '语音选项', exact: true })).toHaveCount(0);
    await expect(voiceOptions).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: '开始连续对话', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByText(/可以说话 · 1 \/ 60 秒/u)).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).activeMicrophones)).toBe(1);
    const opened = await page.evaluate(() => (window as any).openedMicrophones);
    await page.getByRole('button', { name: '结束录音', exact: true }).click();
    await expect(page.getByPlaceholder('随心输入')).toHaveValue('E2E: text');
    await expect(page.getByText('校正并发送后继续', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as any).activeMicrophones)).toBe(0);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect.poll(async () => page.evaluate(() => ((window as any).realtimeEvents as SpeechEvent[]).filter(event => event.type === 'output_closed').length)).toBe(2);
    await expect.poll(() => page.evaluate(() => (window as any).openedMicrophones)).toBe(opened + 1);
    await expect.poll(() => page.evaluate(() => (window as any).activeMicrophones)).toBe(1);
    for (const button of await page.getByLabel('连续语音对话', { exact: true }).getByRole('button').all()) {
      expect(await button.evaluate(element => element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight)).toBe(true);
    }
    await page.screenshot({ path: test.info().outputPath('continuous-voice-session.png') });
    await page.getByRole('button', { name: '静音', exact: true }).click();
    await expect(page.getByText('连续对话已静音', { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).activeMicrophones)).toBe(0);
    await page.getByRole('button', { name: '恢复收音', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).activeMicrophones)).toBe(1);
    await page.keyboard.press('Escape');
    await expect(voiceOptions).toBeVisible();
    await expect(page.getByLabel('连续语音对话', { exact: true })).toHaveCount(0);
    await expect(page.getByText('每轮点击结束录音 · 播放期间停止收音 · Esc 结束', { exact: true })).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (window as any).activeMicrophones)).toBe(0);
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});
