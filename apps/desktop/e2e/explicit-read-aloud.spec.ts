import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { SpeechEvent } from '@desktop-agent/contracts';
import { launchElectron } from './helpers/launch-electron';

test('typed requests read short and bilingual poems completely with automatic reading disabled', async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-explicit-reading-'));
  const previous = process.env.JOJO_E2E_SPEECH; process.env.JOJO_E2E_SPEECH = '1';
  let launched: Awaited<ReturnType<typeof launchElectron>>;
  try { launched = await launchElectron(directory); }
  finally { if (previous === undefined) delete process.env.JOJO_E2E_SPEECH; else process.env.JOJO_E2E_SPEECH = previous; }
  const { app, page } = launched;
  try {
    await page.getByRole('button', { name: '新建对话', exact: true }).click();
    await page.evaluate(() => {
      (window as any).requestedSpeechEvents = []; (window as any).preparedAtPlayback = {};
      window.desktopAgent.onSpeechEvent(event => {
        (window as any).requestedSpeechEvents.push(event);
        if (event.type === 'playback' && event.state === 'playing' && event.messageId) {
          (window as any).preparedAtPlayback[event.messageId] ??= event.preparedChars;
        }
      });
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
        const context = new AudioContext({ sampleRate: 48000 }), tone = context.createOscillator(), destination = context.createMediaStreamDestination();
        tone.connect(destination); tone.start(); await context.resume();
        const track = destination.stream.getAudioTracks()[0]!, stop = track.stop.bind(track);
        track.stop = () => { stop(); tone.stop(); void context.close(); }; return destination.stream;
      } });
    });
    await page.getByRole('button', { name: '设置语音', exact: true }).click();
    const settingsPage = page.getByRole('form', { name: '语音', exact: true });
    await settingsPage.getByLabel('启用语音', { exact: true }).check();
    await settingsPage.getByRole('button', { name: '保存语音设置', exact: true }).click();
    await expect(settingsPage.getByText('所有设置已保存。', { exact: true })).toBeVisible();
    await expect(settingsPage.getByLabel('语音输入后自动朗读回复', { exact: true })).not.toBeChecked();
    await page.getByRole('button', { name: '返回', exact: true }).click();
    const before = await page.evaluate(() => window.desktopAgent.getSpeechStatus());
    await page.getByPlaceholder('随心输入').fill('你给我朗读春花秋月何时了这首词');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.getByText('春花秋月何时了？往事知多少。', { exact: false })).toBeVisible();
    await expect(page.getByText('问君能有几多愁？恰似一江春水向东流。', { exact: false })).toBeVisible();
    await expect.poll(async () => page.evaluate(() => ((window as any).requestedSpeechEvents as SpeechEvent[]).filter(event => event.type === 'reply' && event.requestedReadAloud).length)).toBe(1);
    const reply = await page.evaluate(() => ((window as any).requestedSpeechEvents as SpeechEvent[]).find(event => event.type === 'reply' && event.requestedReadAloud));
    if (!reply || reply.type !== 'reply') throw new Error('Missing requested-read reply receipt.');
    await expect.poll(async () => (await page.evaluate(() => window.desktopAgent.getSpeechStatus())).playbacks.filter(state => state.messageId === reply.messageId && state.state === 'played').length).toBe(1);
    const after = await page.evaluate(() => window.desktopAgent.getSpeechStatus());
    const sessionMessages = await page.evaluate(id => window.desktopAgent.loadMessages(id), reply.sessionId);
    const text = sessionMessages.find(message => message.id === reply.messageId)!.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
    expect(after.diagnostics!.tts.requestedChars - before.diagnostics!.tts.requestedChars).toBe(Array.from(text.replace(/\s+/gu, ' ').trim()).length);
    expect((await page.evaluate(() => window.desktopAgent.getSpeechSettings())).settings.autoReadReplies).toBe(false);
    await page.screenshot({ path: test.info().outputPath('explicit-poem-reading.png') });
    const playedBeforeFollowup = after.playbacks.filter(state => state.state === 'played').length;
    await page.getByPlaceholder('随心输入').fill('开始念'); await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect.poll(async () => page.evaluate(() => ((window as any).requestedSpeechEvents as SpeechEvent[]).filter(event => event.type === 'reply' && event.requestedReadAloud).length)).toBe(2);
    await expect.poll(async () => (await page.evaluate(() => window.desktopAgent.getSpeechStatus())).playbacks.filter(state => state.state === 'played').length).toBe(playedBeforeFollowup + 1);
    // One playback starts early and drains every generated segment in order.
    const beforeBilingual = await page.evaluate(() => window.desktopAgent.getSpeechStatus());
    await page.getByPlaceholder('随心输入').fill('给我念一首英文诗和一首中文诗');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.getByText('让新的清晨陪我们出发。', { exact: false })).toBeVisible();
    await expect.poll(async () => page.evaluate(() => ((window as any).requestedSpeechEvents as SpeechEvent[]).filter(event => event.type === 'reply' && event.requestedReadAloud).length)).toBe(3);
    const bilingual = await page.evaluate(() => ((window as any).requestedSpeechEvents as SpeechEvent[]).filter(event => event.type === 'reply' && event.requestedReadAloud).at(-1));
    if (!bilingual || bilingual.type !== 'reply') throw new Error('Missing bilingual full-reading receipt.');
    const segments = async () => (await page.evaluate(() => window.desktopAgent.getSpeechStatus())).playbacks.filter(state => state.messageId === bilingual.messageId && state.state === 'played');
    await expect.poll(async () => { const played = await segments(); return played.length === 1 && played[0]?.nextOffset === undefined; }).toBe(true);
    const bilingualMessages = await page.evaluate(id => window.desktopAgent.loadMessages(id), bilingual.sessionId);
    const bilingualText = bilingualMessages.find(message => message.id === bilingual.messageId)!.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
    const afterBilingual = await page.evaluate(() => window.desktopAgent.getSpeechStatus());
    const normalizedLength = Array.from(bilingualText.replace(/^#{1,6}\s+/gmu, '').replace(/\s+/gu, ' ').trim()).length;
    expect(normalizedLength).toBeGreaterThan(400);
    expect(afterBilingual.diagnostics!.tts.requestedChars - beforeBilingual.diagnostics!.tts.requestedChars).toBe(normalizedLength);
    expect((await segments())[0]!.preparedChars).toBe(normalizedLength);
    expect(afterBilingual.diagnostics!.tts.requests - beforeBilingual.diagnostics!.tts.requests).toBeGreaterThan(1);
    const preparedAtPlayback = await page.evaluate(messageId => (window as any).preparedAtPlayback[messageId], bilingual.messageId);
    expect(preparedAtPlayback).toBeGreaterThan(0);
    expect(preparedAtPlayback).toBeLessThan(normalizedLength);
    const offsets = (await segments()).flatMap(state => state.nextOffset !== undefined ? [state.nextOffset] : []);
    expect(offsets).toEqual([...new Set(offsets)].sort((a, b) => a - b));
    expect((await page.evaluate(() => window.desktopAgent.getSpeechSettings())).settings.autoReadReplies).toBe(false);
    await expect(page.getByRole('button', { name: '继续朗读助手回复', exact: true })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('bilingual-continuous-reading.png') });
    const played = afterBilingual.playbacks.filter(state => state.state === 'played').length;
    await page.getByRole('button', { name: '⚙ 设置' }).click();
    await page.getByRole('button', { name: '语音', exact: true }).click();
    await settingsPage.getByLabel('语音输入后自动朗读回复', { exact: true }).check();
    await settingsPage.getByRole('button', { name: '保存语音设置', exact: true }).click();
    await expect(settingsPage.getByText('所有设置已保存。', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await page.getByPlaceholder('随心输入').fill('今天天气'); await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.getByText('hello from offline e2e', { exact: true })).toBeVisible();
    await expect.poll(async () => page.evaluate(() => ((window as any).requestedSpeechEvents as SpeechEvent[]).filter(event => event.type === 'reply').length)).toBe(4);
    expect((await page.evaluate(() => window.desktopAgent.getSpeechStatus())).playbacks.filter(state => state.state === 'played').length).toBe(played);
    const ordinary = await page.evaluate(() => ((window as any).requestedSpeechEvents as SpeechEvent[]).filter(event => event.type === 'reply').at(-1));
    if (!ordinary || ordinary.type !== 'reply') throw new Error('Missing ordinary typed reply receipt.');
    expect(ordinary.voiceInput).not.toBe(true); expect(ordinary.requestedReadAloud).not.toBe(true);
    expect((await page.evaluate(() => window.desktopAgent.getSpeechStatus())).playbacks.filter(state => state.messageId === ordinary.messageId)).toHaveLength(0);
    expect((await page.evaluate(() => window.desktopAgent.getSpeechStatus())).diagnostics!.tts.requests).toBe(afterBilingual.diagnostics!.tts.requests);
    await expect(page.locator('.voice-playback-status')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '结束连续对话', exact: true })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('ordinary-text-stays-quiet.png') });
    // Stop a manual full reading while it is preparing; cancellation must not
    // leave a terminal notice above an empty text composer.
    await page.evaluate(messageId => {
      (window as any).stoppedReading = undefined;
      const off = window.desktopAgent.onSpeechEvent(event => {
        if (event.type !== 'playback' || event.messageId !== messageId || event.state !== 'preparing') return;
        off(); (window as any).stoppedReading = event.playbackId;
        void window.desktopAgent.stopSpeechPlayback({ playbackId: event.playbackId });
      });
    }, bilingual.messageId);
    await page.getByRole('button', { name: '朗读助手回复', exact: true }).nth(2).click();
    await expect.poll(async () => page.evaluate(async () => {
      const stopped = (window as any).stoppedReading;
      return stopped && (await window.desktopAgent.getSpeechStatus()).playbacks.find(state => state.playbackId === stopped)?.state;
    })).toBe('interrupted');
    await expect(page.locator('.voice-playback-status')).toHaveCount(0);
    await expect(page.getByPlaceholder('随心输入')).toHaveValue('');
    await expect(page.locator('.voice-notice')).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('stopped-reading-empty-composer.png') });
  } finally { await app.close(); }
});
