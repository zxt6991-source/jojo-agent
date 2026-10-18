import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchElectron } from './helpers/launch-electron';

test('real offline neural model reads bilingual text continuously through bundled Worker and silent AudioHost', async () => {
  test.skip(process.env.JOJO_E2E_NEURAL_REAL !== '1', 'Explicit local model/GPU integration only.');
  test.setTimeout(240_000);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-real-neural-'));
  const installation = path.resolve('../../.local-speech');
  const previous = process.env.JOJO_E2E_SPEECH;
  delete process.env.JOJO_E2E_SPEECH;
  let launched: Awaited<ReturnType<typeof launchElectron>>;
  try { launched = await launchElectron(directory); }
  finally { if (previous !== undefined) process.env.JOJO_E2E_SPEECH = previous; }
  const { app, page } = launched;
  try {
    await page.evaluate(async local => {
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: () => { throw new Error('No microphone in neural synthesis test.'); } });
      const { settings } = await window.desktopAgent.getSpeechSettings();
      await window.desktopAgent.saveSpeechSettings({ settings: { ...settings, enabled: false,
        provider: { ...settings.provider, tts: { ...settings.provider.tts, id: 'mlx-qwen3', speakerId: 'Serena', speechRate: 0, local } },
        playback: { ...settings.playback, volume: 0 }
      } });
      await window.desktopAgent.testSpeechSettings({ generation: 1 });
    }, { pythonPath: path.join(installation, 'venv-mlx-tts/bin/python3'), modelDirectory: path.join(installation, 'models/Qwen3-TTS-0.6B-4bit') });
    await expect.poll(async () => (await page.evaluate(() => window.desktopAgent.getSpeechStatus())).validation.tts, { timeout: 90_000 }).toBe(true);
    const status = await page.evaluate(() => window.desktopAgent.getSpeechStatus());
    expect(status.validation.asr).toBe(false);
    expect(status.diagnostics?.tts.completed).toBe(1);
    expect(status.diagnostics?.tts.audioBytes).toBeGreaterThan(48000);
    const sourceRoot = path.join(directory, 'runtime/neural-tts');
    const versions = await readdir(sourceRoot); expect(versions).toHaveLength(1);
    const sidecar = await readFile(path.join(sourceRoot, versions[0]!, 'mlx_tts.py'), 'utf8');
    expect(sidecar).toContain('trust_remote_code=False');
    expect(sidecar).toContain('lang_code="auto"');
    await page.evaluate(async () => {
      const { settings } = await window.desktopAgent.getSpeechSettings();
      await window.desktopAgent.saveSpeechSettings({ settings: { ...settings, enabled: true, autoReadReplies: false } });
    });
    await page.reload();
    await page.evaluate(() => {
      (window as any).ttsAtPlayback = undefined;
      window.desktopAgent.onSpeechEvent(event => {
        if (event.type === 'playback' && event.state === 'playing' && event.messageId) void window.desktopAgent.getSpeechStatus()
          .then(status => { (window as any).ttsAtPlayback = status.diagnostics!.tts.requests; });
      });
    });
    await page.getByRole('button', { name: '新建对话', exact: true }).click();
    await page.getByPlaceholder('随心输入').fill('给我念一首英文诗和一首中文诗');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.getByText('让新的清晨陪我们出发。', { exact: false })).toBeVisible();
    const reading = async () => (await page.evaluate(() => window.desktopAgent.getSpeechStatus())).playbacks.filter(state => state.messageId);
    await expect.poll(async () => { const played = (await reading()).filter(state => state.state === 'played'); return played.length === 1 && played[0]?.nextOffset === undefined; }, { timeout: 210_000 }).toBe(true);
    const segments = await reading();
    expect(segments.every(state => state.state === 'played')).toBe(true);
    const messages = await page.evaluate(id => window.desktopAgent.loadMessages(id), segments[0]!.sessionId!);
    const text = messages.find(message => message.id === segments[0]!.messageId)!.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
    const after = await page.evaluate(() => window.desktopAgent.getSpeechStatus());
    const normalizedLength = Array.from(text.replace(/^#{1,6}\s+/gmu, '').replace(/\s+/gu, ' ').trim()).length;
    expect(segments[0]!.preparedChars).toBe(normalizedLength);
    // Attempts may include a bounded recovered inference failure. Only ready
    // segments count as prepared text, and none may be generated while playing.
    expect(after.diagnostics!.tts.requestedChars - status.diagnostics!.tts.requestedChars).toBeGreaterThanOrEqual(normalizedLength);
    expect(after.diagnostics!.tts.requests - status.diagnostics!.tts.requests).toBeGreaterThan(1);
    expect(await page.evaluate(() => (window as any).ttsAtPlayback)).toBe(after.diagnostics!.tts.requests);
    await expect(page.getByRole('button', { name: '继续朗读助手回复', exact: true })).toHaveCount(0);
  } finally {
    // Release the GPU model through the normal configuration boundary before exit.
    await page.evaluate(async () => { const { settings } = await window.desktopAgent.getSpeechSettings(); await window.desktopAgent.saveSpeechSettings({ settings: { ...settings, enabled: false, provider: { ...settings.provider, tts: { ...settings.provider.tts, id: 'macos', speakerId: 'default' } } } }); }).catch(() => undefined);
    await app.close();
  }
});
