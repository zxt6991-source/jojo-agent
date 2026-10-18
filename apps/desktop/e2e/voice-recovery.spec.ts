import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { SpeechEvent } from '@desktop-agent/contracts';
import { launchElectron } from './helpers/launch-electron';

test('continuous voice discards broken turns, bounds retries, and resumes without committing partial audio', async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-voice-recovery-'));
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
      (window as any).recoveryEvents = []; (window as any).activeMics = 0; (window as any).micStarts = 0; (window as any).startedRuns = 0;
      (window as any).faultsRemaining = 0; (window as any).brokenCaptures = [];
      window.desktopAgent.onSpeechEvent(event => (window as any).recoveryEvents.push(event));
      window.desktopAgent.onAgentEvent(event => { if (event.type === 'turn.started') (window as any).startedRuns++; });
      // Break the real binary channel's sequence on three captures. Main and
      // Worker must produce normal failures; no fake renderer event is injected.
      window.addEventListener('message', event => {
        if (event.data?.type !== 'jojo.speech.capture.port' || event.data.handle?.purpose !== 'conversation' || !(window as any).faultsRemaining) return;
        const port = event.ports[0]; if (!port) return;
        (window as any).faultsRemaining--;
        (window as any).brokenCaptures.push(event.data.handle.captureId);
        const send = port.postMessage.bind(port);
        port.postMessage = ((frame: any, transfer?: Transferable[]) => {
          if (frame.type === 'audio' && frame.sequence === 1) send({ ...frame, sequence: 2 }, transfer ?? []);
          else send(frame, transfer ?? []);
        }) as typeof port.postMessage;
      });
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
        (window as any).activeMics++; (window as any).micStarts++;
        const context = new AudioContext({ sampleRate: 48000 }), oscillator = context.createOscillator(), destination = context.createMediaStreamDestination();
        oscillator.connect(destination); oscillator.start(); await context.resume();
        const track = destination.stream.getAudioTracks()[0]!, stop = track.stop.bind(track); let stopped = false;
        track.stop = () => { if (stopped) return; stopped = true; (window as any).activeMics--; stop(); oscillator.stop(); void context.close(); };
        return destination.stream;
      } });
    });
    await page.getByRole('button', { name: '设置语音', exact: true }).click();
    const settings = page.getByRole('form', { name: '语音', exact: true });
    await settings.getByLabel('启用语音', { exact: true }).check();
    await settings.getByRole('button', { name: '保存语音设置', exact: true }).click();
    await expect(settings.getByText('所有设置已保存。', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await page.evaluate(() => { (window as any).faultsRemaining = 3; (window as any).micStarts = 0; });
    await page.getByRole('button', { name: '语音选项', exact: true }).click();
    await page.getByRole('menuitem', { name: '开始连续对话', exact: true }).click();
    await expect(page.getByText('本轮未完成，即将重新收音', { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).activeMics)).toBe(0);
    await expect(page.getByText('连续对话已静音', { exact: true })).toBeVisible({ timeout: 15_000 });
    expect(await page.evaluate(() => (window as any).micStarts)).toBe(3);
    expect(await page.evaluate(() => (window as any).activeMics)).toBe(0);
    expect(await page.evaluate(() => (window as any).startedRuns)).toBe(0);
    await expect(page.getByPlaceholder('随心输入')).toHaveValue('');
    await page.screenshot({ path: test.info().outputPath('voice-recovery-muted.png') });
    await page.getByRole('button', { name: '恢复收音', exact: true }).click();
    await expect(page.getByText('校正并发送后继续', { exact: true })).toBeVisible();
    await expect(page.getByPlaceholder('随心输入')).toHaveValue('E2E: text');
    expect(await page.evaluate(() => (window as any).activeMics)).toBe(0);
    expect(await page.evaluate(() => (window as any).startedRuns)).toBe(0);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect.poll(async () => page.evaluate(() => ((window as any).recoveryEvents as SpeechEvent[]).filter(event => event.type === 'output_closed' && event.outcome === 'played').length)).toBe(1);
    await expect(page.getByText('校正并发送后继续', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as any).startedRuns)).toBe(1);
    const events = await page.evaluate(() => (window as any).recoveryEvents as SpeechEvent[]);
    const broken = await page.evaluate(() => (window as any).brokenCaptures as string[]);
    expect(new Set(broken).size).toBe(3);
    for (const id of broken) {
      expect(events.some(event => event.type === 'capture' && event.captureId === id && event.state === 'failed' && event.errorCode === 'invalid_audio')).toBe(true);
      expect(events.some(event => event.type === 'capture' && event.captureId === id && event.state === 'review')).toBe(false);
    }
    await page.getByRole('button', { name: '结束对话', exact: true }).click();
    await expect(page.getByRole('button', { name: '语音选项', exact: true })).toBeVisible();
    await expect(page.getByLabel('连续语音对话', { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).activeMics)).toBe(0);
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});
