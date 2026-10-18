import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { SpeechEvent } from '@desktop-agent/contracts';
import { launchElectron } from './helpers/launch-electron';

type VoiceFixtureWindow = Window & { voiceFixtureEvents: SpeechEvent[]; voiceFixtureMicCalls: number };

test('selects and saves an offline neural voice, then explicitly previews it without opening a microphone', async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-neural-voice-ui-'));
  const previousFlag = process.env.JOJO_E2E_SPEECH;
  process.env.JOJO_E2E_SPEECH = '1';
  let launched: Awaited<ReturnType<typeof launchElectron>>;
  try { launched = await launchElectron(directory); }
  finally { if (previousFlag === undefined) delete process.env.JOJO_E2E_SPEECH; else process.env.JOJO_E2E_SPEECH = previousFlag; }
  const { app, page } = launched;
  try {
    await page.evaluate(async () => {
      const { settings } = await window.desktopAgent.getSpeechSettings();
      await window.desktopAgent.saveSpeechSettings({ settings: { ...settings, playback: { ...settings.playback, volume: 0 } } });
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: () => { throw new Error('Voice selection must not open the microphone.'); } });
    });
    await page.getByRole('button', { name: '新建对话', exact: true }).click();
    await page.getByRole('button', { name: '设置语音', exact: true }).click();
    const form = page.getByRole('form', { name: '语音', exact: true });
    await form.getByLabel('朗读方式', { exact: true }).selectOption('mlx-qwen3');
    await expect(form.getByLabel('朗读服务', { exact: true })).toHaveValue('Qwen3 · 本机自然声音');
    await form.getByLabel('默认声音', { exact: true }).selectOption('Serena');
    await form.getByText('本地模型位置', { exact: true }).click();
    await form.getByLabel('自然声音 Python 路径', { exact: true }).fill('/offline/neural/bin/python3');
    await form.getByLabel('自然声音模型路径', { exact: true }).fill('/offline/neural/model');
    await form.getByLabel('启用语音', { exact: true }).check();
    await form.getByRole('button', { name: '保存语音设置', exact: true }).click();
    await expect(form.getByText('所有设置已保存。', { exact: true })).toBeVisible();
    const saved = await page.evaluate(() => window.desktopAgent.getSpeechSettings());
    expect(saved.settings.provider.tts).toMatchObject({ id: 'mlx-qwen3', speakerId: 'Serena', speechRate: 0, local: { pythonPath: '/offline/neural/bin/python3', modelDirectory: '/offline/neural/model' } });
    expect(saved.settings.enabled).toBe(true);
    expect((await page.evaluate(() => window.desktopAgent.getSpeechStatus())).diagnostics?.tts.requests).toBe(0);
    await form.getByRole('button', { name: '试听声音', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.desktopAgent.getSpeechStatus())).diagnostics?.tts.completed).toBe(1);
    await form.screenshot({ path: test.info().outputPath('offline-neural-voice.png') });
  } finally { await app.close(); }
});

async function expectSpeechSettingsLayout(settingsPage: Locator) {
  const checks = settingsPage.locator('.speech-setting-check');
  await expect(checks).toHaveCount(6);
  for (const label of await checks.all()) {
    const [input, text] = await Promise.all([label.locator('input').boundingBox(), label.locator('span').boundingBox()]);
    if (!input || !text) throw new Error('Speech preference control has no visible bounds.');
    expect(input.width).toBeLessThanOrEqual(20);
    expect(input.height).toBeLessThanOrEqual(20);
    expect(input.width).toBeGreaterThanOrEqual(14);
    expect(input.height).toBeGreaterThanOrEqual(14);
    expect(text.x - (input.x + input.width)).toBeGreaterThanOrEqual(0);
    expect(text.x - (input.x + input.width)).toBeLessThanOrEqual(14);
    expect(Math.abs(input.y + input.height / 2 - (text.y + text.height / 2))).toBeLessThanOrEqual(2);
  }
  const fields = await settingsPage.locator('.speech-setting-field input, .speech-setting-field select').evaluateAll(controls => controls.map(control => {
    const field = control.parentElement!;
    const box = control.getBoundingClientRect();
    const fieldBox = field.getBoundingClientRect();
    const fieldStyle = getComputedStyle(field);
    const style = getComputedStyle(control);
    return {
      name: field.textContent ?? '',
      width: box.width,
      rightGap: fieldBox.right - parseFloat(fieldStyle.paddingRight) - box.right,
      height: box.height,
      textHeight: parseFloat(style.fontSize) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom),
      range: control instanceof HTMLInputElement && control.type === 'range'
    };
  }));
  expect(fields.length).toBeGreaterThanOrEqual(9);
  for (const field of fields) {
    expect(field.width, `${field.name}: form control width`).toBeGreaterThan(150);
    expect(field.rightGap, `${field.name}: form control fills its grid column`).toBeLessThanOrEqual(3);
    expect(field.rightGap, `${field.name}: form control stays inside its field`).toBeGreaterThanOrEqual(-1);
    if (!field.range) expect(field.height, `${field.name}: text is not vertically clipped`).toBeGreaterThanOrEqual(field.textHeight);
  }
  const listen = await settingsPage.getByRole('button', { name: '试听声音', exact: true }).boundingBox();
  if (!listen) throw new Error('Optional voice preview has no visible bounds.');
  expect(listen.height).toBeGreaterThanOrEqual(30);
}

async function screenshotSpeechSettings(settingsPage: Locator, state: string) {
  await settingsPage.locator('.speech-provider-section').screenshot({ path: test.info().outputPath(`speech-providers-${state}.png`) });
  await settingsPage.locator('.speech-preferences-section').screenshot({ path: test.info().outputPath(`speech-preferences-${state}.png`) });
}

async function expectComposerVoiceLayout(page: Page) {
  const composer = page.locator('.composer');
  const actions = composer.locator('.composer-actions');
  const microphone = actions.getByRole('button', { name: '开始录音', exact: true });
  const model = actions.getByRole('combobox', { name: '本轮使用的模型', exact: true });
  const send = actions.getByRole('button', { name: '发送消息', exact: true });
  await expect(microphone).toBeVisible();
  await expect(microphone.locator('svg')).toHaveCount(1);
  await expect(microphone).toHaveText('');
  await expect(composer.getByRole('combobox', { name: '录音操作方式', exact: true })).toHaveCount(0);
  await expect(composer.getByRole('combobox', { name: '语音提交方式', exact: true })).toHaveCount(0);
  const [modelBox, microphoneBox, sendBox] = await Promise.all([model.boundingBox(), microphone.boundingBox(), send.boundingBox()]);
  if (!modelBox || !microphoneBox || !sendBox) throw new Error('Composer voice controls have no visible bounds.');
  expect(modelBox.x + modelBox.width).toBeLessThanOrEqual(microphoneBox.x);
  expect(microphoneBox.x + microphoneBox.width).toBeLessThanOrEqual(sendBox.x);
  expect(Math.abs(microphoneBox.y + microphoneBox.height / 2 - (sendBox.y + sendBox.height / 2))).toBeLessThanOrEqual(2);
}

test('saved speech settings work directly with real PCM worklet, review commit deduplication and completed message playback', async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-voice-conversation-'));
  const previousFlag = process.env.JOJO_E2E_SPEECH;
  // The helper also sets JOJO_E2E=1. Both are required to select the fake service.
  process.env.JOJO_E2E_SPEECH = '1';
  let launched: Awaited<ReturnType<typeof launchElectron>>;
  try { launched = await launchElectron(directory); }
  finally { if (previousFlag === undefined) delete process.env.JOJO_E2E_SPEECH; else process.env.JOJO_E2E_SPEECH = previousFlag; }
  const { app, page } = launched;
  try {
    // This settings write remains offline and keeps the output silent.
    await page.evaluate(async () => {
      const { settings } = await window.desktopAgent.getSpeechSettings();
      await window.desktopAgent.saveSpeechSettings({ settings: { ...settings, playback: { ...settings.playback, volume: 0 } } });
    });
    await page.reload();
    await page.evaluate(() => {
      const fixture = window as unknown as VoiceFixtureWindow;
      fixture.voiceFixtureEvents = []; fixture.voiceFixtureMicCalls = 0;
      window.desktopAgent.onSpeechEvent(event => fixture.voiceFixtureEvents.push(event));
      // The production AudioWorklet receives a real MediaStream with synthesized audio.
      // No OS input device is opened and the oscillator never connects to speakers.
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async (constraints: MediaStreamConstraints) => {
        if (constraints.video !== false || !constraints.audio) throw new Error('Fixture requires audio only.');
        fixture.voiceFixtureMicCalls += 1;
        const context = new AudioContext({ sampleRate: 48_000 });
        const tone = context.createOscillator(); tone.frequency.value = 440;
        const gain = context.createGain(); gain.gain.value = 0.05;
        const destination = context.createMediaStreamDestination();
        tone.connect(gain); gain.connect(destination); tone.start(); await context.resume();
        const track = destination.stream.getAudioTracks()[0]!;
        const stop = track.stop.bind(track);
        track.stop = () => { stop(); tone.stop(); void context.close(); };
        return destination.stream;
      } });
    });
    await page.getByRole('button', { name: '新建对话', exact: true }).click();
    await expect(page.getByRole('button', { name: '设置语音', exact: true })).toBeVisible();
    const initialSessionId = (await page.evaluate(() => window.desktopAgent.listSessions()))[0]!.id;
    await page.getByRole('button', { name: '设置语音', exact: true }).click();
    const settingsPage = page.getByRole('form', { name: '语音', exact: true });
    await expect(settingsPage.getByText('显式验证', { exact: true })).toHaveCount(0);
    await expect(settingsPage.getByLabel('语音启用说明', { exact: true })).toHaveCount(0);
    await expect(settingsPage.getByRole('button', { name: '开始录音', exact: true })).toHaveCount(0);
    await expect(settingsPage.getByLabel('启用语音', { exact: true })).toBeEnabled();
    await expect(settingsPage.getByLabel('API Key', { exact: true })).toHaveCount(0);
    await expect(settingsPage.getByText(/原始录音不会保存/u)).toBeVisible();
    await expectSpeechSettingsLayout(settingsPage);
    await screenshotSpeechSettings(settingsPage, 'disabled');
    await expect(settingsPage.getByRole('textbox', { name: '转写服务', exact: true })).toHaveValue('SenseVoice · 本地识别');
    await expect(settingsPage.getByRole('textbox', { name: '朗读服务', exact: true })).toHaveValue('Mac 系统朗读');
    await settingsPage.getByLabel('启用语音', { exact: true }).check();
    await settingsPage.getByRole('button', { name: '保存语音设置', exact: true }).click();
    await expect(settingsPage.getByText('所有设置已保存。', { exact: true })).toBeVisible();
    const untested = await page.evaluate(() => window.desktopAgent.getSpeechStatus());
    expect(untested.diagnostics?.asr.requests).toBe(0);
    expect(untested.diagnostics?.tts.requests).toBe(0);
    expect(await page.evaluate(() => (window as unknown as VoiceFixtureWindow).voiceFixtureMicCalls)).toBe(0);
    expect((await page.evaluate(() => window.desktopAgent.listSessions())).map(session => session.id)).toEqual([initialSessionId]);
    expect(await page.evaluate(id => window.desktopAgent.loadMessages(id), initialSessionId)).toHaveLength(0);
    await expectSpeechSettingsLayout(settingsPage);
    await settingsPage.screenshot({ path: test.info().outputPath('speech-settings-direct-save.png') });
    const originalSize = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.isVisible())!.getSize());
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.isVisible())!.setSize(900, 820));
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(900);
    await expectSpeechSettingsLayout(settingsPage);
    await screenshotSpeechSettings(settingsPage, 'narrow');
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows().find(window => window.isVisible())!.setSize(size[0]!, size[1]!), originalSize);
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeGreaterThan(900);
    await expect.poll(() => page.evaluate(async () => (await window.desktopAgent.getSpeechSettings()).settings.enabled)).toBe(true);
    await expect(settingsPage.getByLabel('语音启用说明', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await expectComposerVoiceLayout(page);
    await page.getByRole('button', { name: '开始录音', exact: true }).click();
    await expect(page.getByText(/可以说话 · 1 \/ 60 秒/u)).toBeVisible();
    await expect(page.locator('.composer-actions').getByRole('button', { name: '停止录音', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.locator('.composer-wrap').screenshot({ path: test.info().outputPath('voice-composer-recording.png') });
    await page.getByRole('button', { name: '结束录音', exact: true }).click();
    await expect(page.getByPlaceholder('随心输入')).toHaveValue('E2E: text');
    const sessions = await page.evaluate(() => window.desktopAgent.listSessions());
    const sessionId = sessions[0]!.id;
    expect(await page.evaluate(id => window.desktopAgent.loadMessages(id), sessionId)).toHaveLength(0);
    // Correcting the final transcript follows the voice commit path rather than creating another turn.
    await page.getByPlaceholder('随心输入').fill('E2E: text 已经校正');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.getByText('hello from offline e2e', { exact: true })).toBeVisible();
    const receipt = await page.evaluate(() => (window as unknown as VoiceFixtureWindow).voiceFixtureEvents.find(event => event.type === 'capture' && event.purpose === 'conversation' && event.state === 'review'));
    if (!receipt || receipt.type !== 'capture') throw new Error('No reviewed conversation receipt.');
    const commits = await page.evaluate(async ({ capture, id }) => {
      const settings = await window.desktopAgent.getSettings();
      const model = settings.providers.find(provider => provider.id === settings.activeProviderId)!.model;
      const input = { sessionId: id, voiceTurnId: capture.voiceTurnId, generation: capture.generation, text: 'E2E: text 已经校正', providerId: settings.activeProviderId, model };
      return Promise.all([window.desktopAgent.commitVoiceTurn(input), window.desktopAgent.commitVoiceTurn(input)]);
    }, { capture: receipt, id: sessionId });
    expect(commits.map(commit => commit.status)).toEqual(['committed', 'committed']);
    expect(commits[0]!.runId).toBeTruthy(); expect(commits[0]!.runId).toBe(commits[1]!.runId);
    const messages = await page.evaluate(id => window.desktopAgent.loadMessages(id), sessionId);
    expect(messages.filter(message => message.role === 'user')).toHaveLength(1);
    expect(messages.find(message => message.role === 'user')?.content).toContainEqual({ type: 'text', text: 'E2E: text 已经校正' });
    expect(messages.find(message => message.role === 'user')?.metadata?.voice).toEqual({ voiceTurnId: receipt.voiceTurnId, generation: receipt.generation });
    const assistant = messages.find(message => message.role === 'assistant' && message.content.some(block => block.type === 'text' && block.text === 'hello from offline e2e'))!;
    await page.getByRole('button', { name: '朗读助手回复', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.desktopAgent.getSpeechStatus())).playbacks.some(playback => playback.sessionId === sessionId && playback.messageId === assistant.id && playback.state === 'played')).toBe(true);
    expect(await page.evaluate(() => (window as unknown as VoiceFixtureWindow).voiceFixtureMicCalls)).toBe(1);

    // The second round exercises the opted-in automatic path through the same real Worklet.
    await page.getByRole('button', { name: '⚙ 设置' }).click();
    await page.getByRole('button', { name: '语音', exact: true }).click();
    await settingsPage.getByLabel('转写后').selectOption('auto_send');
    await settingsPage.getByLabel('语音输入后自动朗读回复', { exact: true }).check();
    await settingsPage.getByRole('button', { name: '保存语音设置', exact: true }).click();
    await expect.poll(async () => {
      const settings = (await page.evaluate(() => window.desktopAgent.getSpeechSettings())).settings;
      return { inputMode: settings.inputMode, autoReadReplies: settings.autoReadReplies, volume: settings.playback.volume, enabled: settings.enabled };
    }).toEqual({ inputMode: 'auto_send', autoReadReplies: true, volume: 0, enabled: true });
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await page.getByRole('button', { name: '开始录音', exact: true }).click();
    await expect(page.getByText(/可以说话 · 1 \/ 60 秒/u)).toBeVisible();
    await page.getByRole('button', { name: '结束录音', exact: true }).click();
    // No send-button click: only the final ASR result may commit one new Run.
    await expect(page.getByText('hello from offline e2e', { exact: true })).toHaveCount(2);
    await expect(page.getByPlaceholder('随心输入')).toHaveValue('');
    const automaticMessages = await page.evaluate(id => window.desktopAgent.loadMessages(id), sessionId);
    const automaticUsers = automaticMessages.filter(message => message.role === 'user');
    const automaticAssistants = automaticMessages.filter(message => message.role === 'assistant' && message.content.some(block => block.type === 'text' && block.text === 'hello from offline e2e'));
    expect(automaticUsers).toHaveLength(2); expect(automaticAssistants).toHaveLength(2);
    expect(automaticUsers[1]!.content).toContainEqual({ type: 'text', text: 'E2E: text' });
    const automaticAssistant = automaticAssistants[1]!;
    await expect.poll(async () => (await page.evaluate(() => window.desktopAgent.getSpeechStatus())).playbacks.filter(playback => playback.sessionId === sessionId && playback.messageId === automaticAssistant.id && playback.state === 'played').length).toBe(1);
    const automaticEvents = await page.evaluate(() => (window as unknown as VoiceFixtureWindow).voiceFixtureEvents);
    const automaticCapture = [...automaticEvents].reverse().find(event => event.type === 'capture' && event.purpose === 'conversation' && event.state === 'review');
    if (!automaticCapture || automaticCapture.type !== 'capture') throw new Error('No automatic capture receipt.');
    const automaticCommit = automaticEvents.find(event => event.type === 'commit' && event.voiceTurnId === automaticCapture.voiceTurnId && event.generation === automaticCapture.generation && event.status === 'committed');
    const automaticReply = automaticEvents.find(event => event.type === 'reply' && event.sessionId === sessionId && event.messageId === automaticAssistant.id);
    if (!automaticCommit || automaticCommit.type !== 'commit' || !automaticReply || automaticReply.type !== 'reply') throw new Error('Automatic reply lacks its committed Run receipt.');
    expect(automaticCommit.runId).toBe(automaticReply.runId);
    expect(automaticCommit.runId).not.toBe(commits[0]!.runId);
    expect(automaticCapture.voiceTurnId).not.toBe(receipt.voiceTurnId);
    expect(automaticUsers[1]!.metadata?.voice).toEqual({ voiceTurnId: automaticCapture.voiceTurnId, generation: automaticCapture.generation });
    expect(await page.evaluate(() => (window as unknown as VoiceFixtureWindow).voiceFixtureMicCalls)).toBe(2);

    // Changing the active session leaves a normal empty composer and preserves the previous transcript.
    const nextSession = await page.evaluate(() => window.desktopAgent.createSession({ title: '语音隔离测试' }));
    if (!nextSession) throw new Error('Cannot create the isolated second session.');
    await page.getByRole('button', { name: nextSession.title, exact: true }).click();
    await expect(page.getByPlaceholder('随心输入')).toHaveValue('');
    await expect(page.getByRole('button', { name: '开始录音', exact: true })).toBeEnabled();
    await expectComposerVoiceLayout(page);
    await page.locator('.composer-wrap').screenshot({ path: test.info().outputPath('voice-composer-idle.png') });
    expect(await page.evaluate(id => window.desktopAgent.loadMessages(id), nextSession.id)).toHaveLength(0);
    expect((await page.evaluate(id => window.desktopAgent.loadMessages(id), sessionId)).filter(message => message.role === 'user')).toHaveLength(2);
    expect(await page.evaluate(async () => JSON.stringify(await window.desktopAgent.getSpeechStatus()).includes('offline-voice-fixture-'))).toBe(false);

    // A durable pure reminder survives an explicitly opted-in window close.
    // The same Main/Worker/AudioHost chain runs silently with the offline service.
    await page.evaluate(async () => {
      const { settings } = await window.desktopAgent.getSpeechSettings();
      await window.desktopAgent.saveSpeechSettings({ settings: { ...settings, backgroundRunning: true } });
    });
    const reminderText = '离线提醒：喝水';
    const reminder = await page.evaluate(async ({ text, id }) => window.desktopAgent.saveSchedule({
      name: '后台语音提醒测试', enabled: true,
      spec: { kind: 'once', runAt: new Date(Date.now() + 2_000).toISOString() },
      target: { kind: 'reminder', text },
      delivery: {
        conversation: { enabled: true, sessionId: id }, notification: { enabled: true },
        voice: { enabled: true, deviceId: 'local-desktop', content: { kind: 'result', maxChars: 200 }, expiresAfterMs: 600_000 }
      }, misfire: { kind: 'fire_once', graceMs: 60_000 }
    }), { text: reminderText, id: sessionId });
    const mainWindowId = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(candidate => candidate.isVisible())!;
      const id = window.id; window.close(); return id;
    });
    await expect.poll(() => app.evaluate(({ BrowserWindow }, id) => {
      const window = BrowserWindow.fromId(id); return Boolean(window && !window.isDestroyed() && !window.isVisible());
    }, mainWindowId)).toBe(true);
    await expect.poll(async () => {
      const runs = await page.evaluate(id => window.desktopAgent.listScheduleRuns({ scheduleId: id }), reminder.id);
      return runs[0]?.deliveryItems?.map(item => `${item.destination}:${item.state}`).sort();
    }).toEqual(['conversation:delivered', 'notification:delivered', 'voice:played']);
    const reminderRun = (await page.evaluate(id => window.desktopAgent.listScheduleRuns({ scheduleId: id }), reminder.id))[0]!;
    expect(reminderRun.status).toBe('completed');
    expect(reminderRun.targetKind).toBe('reminder');
    const voiceItem = reminderRun.deliveryItems!.find(item => item.destination === 'voice')!;
    const firstPlayback = await page.evaluate(() => [...(window as unknown as VoiceFixtureWindow).voiceFixtureEvents]
      .reverse().find(event => event.type === 'playback' && !event.sessionId && event.state === 'played'));
    if (!firstPlayback || firstPlayback.type !== 'playback') throw new Error('Scheduled AudioHost never confirmed playback.');
    const deliveredMessages = await page.evaluate(id => window.desktopAgent.loadMessages(id), sessionId);
    const reminderMessages = deliveredMessages.filter(message => message.metadata?.automation?.scheduleRunId === reminderRun.id);
    expect(reminderMessages).toHaveLength(1);
    expect(reminderMessages[0]!.content).toContainEqual({ type: 'text', text: reminderText });
    expect(deliveredMessages.filter(message => message.role === 'user')).toHaveLength(2);
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.show(), mainWindowId);
    await page.getByRole('button', { name: '⚙ 设置' }).click();
    await page.getByRole('button', { name: 'Automations', exact: true }).click();
    await page.locator('.automation-list').getByRole('button', { name: /后台语音提醒测试/u }).click();
    await expect(page.getByRole('textbox', { name: '提醒内容', exact: true })).toHaveValue(reminderText);
    const deliveryHistory = page.getByRole('list', { name: '各目的地投递状态', exact: true });
    await expect(deliveryHistory.getByText('语音：已播完', { exact: true })).toBeVisible();
    await expect(deliveryHistory.getByText('系统通知：已投递', { exact: true })).toBeVisible();
    await page.locator('.automation-history').screenshot({ path: test.info().outputPath('scheduled-reminder-deliveries.png') });
    await deliveryHistory.getByRole('button', { name: '重新播报', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => (window as unknown as VoiceFixtureWindow).voiceFixtureEvents))
      .some(event => event.type === 'playback' && event.playbackId !== firstPlayback.playbackId && !event.sessionId && event.state === 'played')).toBe(true);
    await expect.poll(async () => (await page.evaluate(id => window.desktopAgent.listScheduleRuns({ scheduleId: id }), reminder.id))[0]
      ?.deliveryItems?.find(item => item.id === voiceItem.id)?.state).toBe('played');
    const replayedMessages = await page.evaluate(id => window.desktopAgent.loadMessages(id), sessionId);
    expect(replayedMessages.filter(message => message.metadata?.automation?.scheduleRunId === reminderRun.id)).toHaveLength(1);
    expect(replayedMessages.filter(message => message.role === 'user')).toHaveLength(2);

    // Independent presets are saved before their own explicit playback test.
    await page.getByRole('button', { name: '语音', exact: true }).click();
    await settingsPage.getByRole('button', { name: '添加音色预设', exact: true }).click();
    await settingsPage.getByRole('textbox', { name: '预设 1 名称', exact: true }).fill('工作提醒');
    await settingsPage.getByRole('textbox', { name: '预设 1 系统声音名称', exact: true }).fill('offline-preset-speaker');
    await expect(settingsPage.getByRole('button', { name: '试听此预设', exact: true })).toBeDisabled();
    await settingsPage.getByRole('button', { name: '保存语音设置', exact: true }).click();
    await expect(settingsPage.getByRole('button', { name: '试听此预设', exact: true })).toBeEnabled();
    await settingsPage.getByRole('button', { name: '试听此预设', exact: true }).click();
    await expect(settingsPage.locator('.speech-preset-card').getByText('本次试听已完成', { exact: true })).toBeVisible();
    const preset = (await page.evaluate(() => window.desktopAgent.getSpeechSettings())).settings.voicePresets[0]!;
    const upcoming = await page.evaluate(({ presetId }) => window.desktopAgent.saveSchedule({
      name: '预缓存与试听测试', enabled: true,
      spec: { kind: 'once', runAt: new Date(Date.now() + 3_600_000).toISOString() },
      target: { kind: 'reminder', text: '该活动一下了。' },
      delivery: { voice: { enabled: true, deviceId: 'local-desktop', presetId, content: { kind: 'result', maxChars: 200 }, expiresAfterMs: 600_000 } }
    }), { presetId: preset.id });
    await expect.poll(async () => (await page.evaluate(scheduleId => window.desktopAgent.getScheduleVoicePreparation({ scheduleId }), upcoming.id)).state).toBe('ready');
    await page.getByRole('button', { name: 'Automations', exact: true }).click();
    await page.locator('.automation-list').getByRole('button', { name: /预缓存与试听测试/u }).click();
    await expect(page.getByRole('combobox', { name: '播报音色', exact: true })).toHaveValue(preset.id);
    await expect(page.getByText('语音已准备', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '试听已保存文案', exact: true }).click();
    await expect(page.getByText('本次试听已完成', { exact: true })).toBeVisible();
    expect(await page.evaluate(scheduleId => window.desktopAgent.listScheduleRuns({ scheduleId }), upcoming.id)).toHaveLength(0);
    await page.locator('.automation-voice-preview').screenshot({ path: test.info().outputPath('reminder-preview-ready.png') });
    await page.getByRole('button', { name: '语音', exact: true }).click();
    await settingsPage.getByRole('button', { name: '清除语音缓存', exact: true }).click();
    await expect(settingsPage.getByText('本机语音缓存已清除。', { exact: true })).toBeVisible();
    await expect.poll(async () => (await page.evaluate(scheduleId => window.desktopAgent.getScheduleVoicePreparation({ scheduleId }), upcoming.id)).state).toBe('not_prepared');
    await settingsPage.getByText('本次启动统计', { exact: true }).click();
    await settingsPage.getByRole('button', { name: '刷新统计', exact: true }).click();
    const diagnostics = (await page.evaluate(() => window.desktopAgent.getSpeechStatus())).diagnostics!;
    expect(diagnostics.asr.requests).toBe(2);
    expect(diagnostics.tts.requests).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(diagnostics)).not.toContain('offline-voice-fixture-');
    await settingsPage.locator('.speech-presets-section').screenshot({ path: test.info().outputPath('speech-independent-presets.png') });
    await page.getByRole('button', { name: '返回', exact: true }).click();

    // Typed conversation stays silent even with automatic voice replies enabled.
    // A manual click explicitly authorizes the complete reading.
    await page.getByPlaceholder('随心输入').fill('E2E: long speech');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.getByRole('button', { name: '朗读助手回复', exact: true })).toBeVisible();
    const longReply = (await page.evaluate(id => window.desktopAgent.loadMessages(id), nextSession.id))
      .find(message => message.role === 'assistant' && message.content.some(block => block.type === 'text' && block.text.length > 1_000))!;
    const playedSegments = async () => (await page.evaluate(() => window.desktopAgent.getSpeechStatus())).playbacks
      .filter(playback => playback.messageId === longReply.id && playback.state === 'played');
    expect(await playedSegments()).toHaveLength(0);
    const beforeManual = await page.evaluate(() => window.desktopAgent.getSpeechStatus());
    await page.getByRole('button', { name: '朗读助手回复', exact: true }).click();
    await expect.poll(async () => { const segments = await playedSegments(); return segments.length === 1 && segments.at(-1)?.nextOffset === undefined; }).toBe(true);
    await expect(page.getByRole('button', { name: '继续朗读助手回复', exact: true })).toHaveCount(0);
    const afterManual = await page.evaluate(() => window.desktopAgent.getSpeechStatus());
    const syntheses = afterManual.diagnostics!.tts.requests - beforeManual.diagnostics!.tts.requests;
    const reused = afterManual.diagnostics!.tts.cacheHits - beforeManual.diagnostics!.tts.cacheHits;
    expect(syntheses + reused).toBeGreaterThan(1);
    expect(reused).toBeGreaterThan(0); // Identical phrases remain eligible for audio cache reuse.

    // An approval in a typed task also stays silent.
    await page.getByPlaceholder('随心输入').fill('E2E: approval deny');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const beforeApproval = (await playedSegments()).length;
    expect((await page.evaluate(() => window.desktopAgent.getSpeechStatus())).playbacks
      .some(playback => playback.sessionId === nextSession.id && !playback.messageId && playback.state === 'played')).toBe(false);
    await expect(page.locator('.voice-playback-status')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await playedSegments()).toHaveLength(beforeApproval);
    await page.getByRole('button', { name: '拒绝', exact: false }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();

    // Discarding a transcript releases its capture; later typing is an ordinary message.
    await page.getByRole('button', { name: '⚙ 设置' }).click();
    await page.getByRole('button', { name: '语音', exact: true }).click();
    await settingsPage.getByLabel('转写后').selectOption('review');
    await settingsPage.getByLabel('语音输入后自动朗读回复', { exact: true }).uncheck();
    await settingsPage.getByRole('button', { name: '保存语音设置', exact: true }).click();
    await expect.poll(() => page.evaluate(async () => (await window.desktopAgent.getSpeechSettings()).settings.inputMode)).toBe('review');
    await page.getByRole('button', { name: '返回', exact: true }).click();
    const clearedSession = await page.evaluate(() => window.desktopAgent.createSession({ title: '清空语音草稿测试' }));
    if (!clearedSession) throw new Error('Cannot create the discarded voice draft session.');
    await page.getByRole('button', { name: clearedSession.title, exact: true }).click();
    const composerInput = page.getByPlaceholder('随心输入');
    for (const [index, blank] of ['', ' \n\t '].entries()) {
      await page.getByRole('button', { name: '开始录音', exact: true }).click();
      await expect(page.getByText(/可以说话 · 1 \/ 60 秒/u)).toBeVisible();
      await page.getByRole('button', { name: '结束录音', exact: true }).click();
      await expect(composerInput).toHaveValue('E2E: text');
      await expect(page.getByText('识别完成，可校正后发送。', { exact: true })).toBeVisible();
      const discarded = await page.evaluate(id => [...(window as unknown as VoiceFixtureWindow).voiceFixtureEvents]
        .reverse().find(event => event.type === 'capture' && event.sessionId === id && event.state === 'review'), clearedSession.id);
      if (!discarded || discarded.type !== 'capture') throw new Error('No transcript to discard.');
      await composerInput.fill(blank);
      await expect(page.locator('.voice-notice')).toHaveCount(0);
      await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
      await expect.poll(() => page.evaluate(async captureId => (await window.desktopAgent.getSpeechStatus()).captures
        .find(capture => capture.captureId === captureId)?.state, discarded.captureId)).toBe('cancelled');
      const text = `E2E: manually typed after clearing voice ${index + 1}`;
      await composerInput.fill(text);
      await page.getByRole('button', { name: '发送消息', exact: true }).click();
      await expect(page.getByText('hello from offline e2e', { exact: true })).toHaveCount(index + 1);
      const typed = (await page.evaluate(id => window.desktopAgent.loadMessages(id), clearedSession.id))
        .find(message => message.role === 'user' && message.content.some(block => block.type === 'text' && block.text === text));
      expect(typed).toBeDefined();
      expect(typed!.metadata?.voice).toBeUndefined();
      expect(await page.evaluate(voiceTurnId => (window as unknown as VoiceFixtureWindow).voiceFixtureEvents
        .some(event => event.type === 'commit' && event.voiceTurnId === voiceTurnId), discarded.voiceTurnId)).toBe(false);
    }

    const enableAutoRead = async () => {
      await page.getByRole('button', { name: '⚙ 设置' }).click();
      await page.getByRole('button', { name: '语音', exact: true }).click();
      await settingsPage.getByLabel('语音输入后自动朗读回复', { exact: true }).check();
      await settingsPage.getByRole('button', { name: '保存语音设置', exact: true }).click();
      await expect.poll(() => page.evaluate(async () => (await window.desktopAgent.getSpeechSettings()).settings.autoReadReplies)).toBe(true);
      await page.getByRole('button', { name: '返回', exact: true }).click();
    };
    const replyCount = () => page.evaluate(id => (window as unknown as VoiceFixtureWindow).voiceFixtureEvents
      .filter(event => event.type === 'reply' && event.sessionId === id).length, clearedSession.id);
    await enableAutoRead();
    const beforeQuietReplies = (await page.evaluate(() => window.desktopAgent.getSpeechStatus())).diagnostics!.tts.requests;
    // A spoken-output refusal changes the real persisted preference before this reply.
    for (const [index, text] of ['我没说读出来不要自己读', '英语怎么学'].entries()) {
      await composerInput.fill(text);
      await page.getByRole('button', { name: '发送消息', exact: true }).click();
      await expect(page.getByText('hello from offline e2e', { exact: true })).toHaveCount(index + 3);
      await expect.poll(replyCount).toBe(index + 3);
      expect((await page.evaluate(() => window.desktopAgent.getSpeechSettings())).settings.autoReadReplies).toBe(false);
    }
    expect((await page.evaluate(() => window.desktopAgent.getSpeechStatus())).diagnostics!.tts.requests).toBe(beforeQuietReplies);

    // Manual reading and explicitly scheduled voice delivery remain available.
    const quietAssistant = (await page.evaluate(id => window.desktopAgent.loadMessages(id), clearedSession.id))
      .filter(message => message.role === 'assistant').at(-1)!;
    await page.getByRole('button', { name: '朗读助手回复', exact: true }).last().click();
    await expect.poll(async () => (await page.evaluate(() => window.desktopAgent.getSpeechStatus())).playbacks
      .some(playback => playback.messageId === quietAssistant.id && playback.state === 'played')).toBe(true);
    const quietReminder = await page.evaluate(sessionId => window.desktopAgent.saveSchedule({
      name: '自动朗读关闭后的独立提醒', enabled: true,
      spec: { kind: 'once', runAt: new Date(Date.now() + 1_500).toISOString() },
      target: { kind: 'reminder', text: '这是独立的语音提醒。' },
      delivery: { conversation: { enabled: false, sessionId }, voice: { enabled: true, deviceId: 'local-desktop', content: { kind: 'result', maxChars: 200 }, expiresAfterMs: 60_000 } }
    }), clearedSession.id);
    await expect.poll(async () => (await page.evaluate(id => window.desktopAgent.listScheduleRuns({ scheduleId: id }), quietReminder.id))[0]
      ?.deliveryItems?.find(item => item.destination === 'voice')?.state).toBe('played');

    // Corrected voice input uses the same refusal policy as typed input.
    await enableAutoRead();
    await page.getByRole('button', { name: '开始录音', exact: true }).click();
    await expect(page.getByText(/可以说话 · 1 \/ 60 秒/u)).toBeVisible();
    await page.getByRole('button', { name: '结束录音', exact: true }).click();
    await expect(composerInput).toHaveValue('E2E: text');
    const beforeQuietVoice = (await page.evaluate(() => window.desktopAgent.getSpeechStatus())).diagnostics!.tts.requests;
    await composerInput.fill('别自动朗读，只显示文字。');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.getByText('hello from offline e2e', { exact: true })).toHaveCount(5);
    await expect.poll(replyCount).toBe(5);
    expect((await page.evaluate(() => window.desktopAgent.getSpeechSettings())).settings.autoReadReplies).toBe(false);
    expect((await page.evaluate(() => window.desktopAgent.getSpeechStatus())).diagnostics!.tts.requests).toBe(beforeQuietVoice);
    const quietVoice = (await page.evaluate(id => window.desktopAgent.loadMessages(id), clearedSession.id))
      .find(message => message.role === 'user' && message.content.some(block => block.type === 'text' && block.text === '别自动朗读，只显示文字。'));
    expect(quietVoice?.metadata?.voice).toBeDefined();
  } finally { await app.close(); }
});
