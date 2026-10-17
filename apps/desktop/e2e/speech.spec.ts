import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';

import { launchElectron } from './helpers/launch-electron';

test('local speech configuration persists across preload/main/worker and restart without starting speech', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-speech-boundary-'));
  const configPath = path.join(directory, 'config.json');
  let launched = await launchElectron(directory);
  let open = true;
  try {
    const initial = await launched.page.evaluate(() => window.desktopAgent.getSpeechSettings());
    expect(Object.keys(initial)).toEqual(['settings']);
    expect(initial.settings.enabled).toBe(false);
    expect(initial.settings.provider.asr.id).toBe('sensevoice');
    expect(initial.settings.provider.tts).toMatchObject({ id: 'macos', format: 'wav' });

    // This is the production Worker-owned database, not a replaced IPC handler or test adapter.
    await expect.poll(() => existsSync(path.join(directory, 'runtime', 'speech.sqlite'))).toBe(true);

    await launched.page.getByRole('button', { name: '⚙ 设置' }).click();
    await launched.page.getByRole('button', { name: '语音', exact: true }).click();
    const form = launched.page.getByRole('form', { name: '语音', exact: true });
    await expect(form.getByRole('textbox', { name: '转写服务', exact: true })).toHaveValue('SenseVoice · 本地识别');
    await expect(form.getByRole('textbox', { name: '朗读服务', exact: true })).toHaveValue('Mac 系统朗读');
    await form.getByRole('textbox', { name: 'SenseVoice 模型目录', exact: true }).fill('/offline/local-model');
    await form.getByRole('textbox', { name: '本地语音 Python 路径', exact: true }).fill('/offline/python3');
    await form.getByRole('button', { name: '保存语音设置', exact: true }).click();
    await expect(form.getByText('所有设置已保存。', { exact: true })).toBeVisible();
    const selected = await launched.page.evaluate(() => window.desktopAgent.getSpeechSettings());
    expect(selected.settings.provider.asr.local).toMatchObject({ modelDirectory: '/offline/local-model', pythonPath: '/offline/python3' });

    const saved = await launched.page.evaluate(async () => {
      const { settings } = await window.desktopAgent.getSpeechSettings();
      settings.inputMode = 'auto_send';
      settings.provider.asr.local.language = 'zh';
      settings.provider.tts.speakerId = 'Tingting';
      settings.provider.tts.speechRate = 17;
      settings.playback.volume = 0.25;
      return window.desktopAgent.saveSpeechSettings({ settings });
    });
    expect(Object.keys(saved)).toEqual(['settings']);
    expect(saved.settings.enabled).toBe(false);

    const config = JSON.parse(await readFile(configPath, 'utf8'));
    expect(config.speech).toEqual(saved.settings);

    const afterModelSave = await launched.page.evaluate(async () => {
      const settings = await window.desktopAgent.getSettings();
      const provider = { ...settings.providers[0]!, name: 'Offline speech boundary model' };
      await window.desktopAgent.saveSettings({ activeProviderId: settings.activeProviderId, provider, utilityModel: settings.utilityModel });
      return window.desktopAgent.getSpeechSettings();
    });
    expect(afterModelSave).toEqual(saved);

    await launched.app.close();
    open = false;
    launched = await launchElectron(directory);
    open = true;
    expect(await launched.page.evaluate(() => window.desktopAgent.getSpeechSettings())).toEqual(saved);

    // Saving paths does not substitute for explicit recording and listening tests.
    await expect(launched.page.evaluate(async () => {
      const { settings } = await window.desktopAgent.getSpeechSettings();
      return window.desktopAgent.saveSpeechSettings({ settings: { ...settings, enabled: true } });
    })).rejects.toThrow('语音资源与音色尚未验证');
    expect(await launched.page.evaluate(() => window.desktopAgent.getSpeechSettings())).toEqual(saved);
    const status = await launched.page.evaluate(() => window.desktopAgent.getSpeechStatus());
    expect(status.diagnostics?.asr.requests).toBe(0);
    expect(status.diagnostics?.tts.requests).toBe(0);
  } finally {
    if (open) await launched.app.close();
  }
});
