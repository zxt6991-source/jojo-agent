import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchElectron } from './helpers/launch-electron';

test('missing neural installation fails before playing and shows a clean engine-specific message', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-neural-unavailable-'));
  const previous = process.env.JOJO_E2E_SPEECH; delete process.env.JOJO_E2E_SPEECH;
  let launched: Awaited<ReturnType<typeof launchElectron>>;
  try { launched = await launchElectron(directory); }
  finally { if (previous !== undefined) process.env.JOJO_E2E_SPEECH = previous; }
  const { app, page } = launched;
  try {
    await page.evaluate(async missing => {
      const { settings } = await window.desktopAgent.getSpeechSettings();
      await window.desktopAgent.saveSpeechSettings({ settings: { ...settings, enabled: true, autoReadReplies: false,
        provider: { ...settings.provider, tts: { ...settings.provider.tts, id: 'mlx-qwen3', speakerId: 'Serena', speechRate: 0,
          local: { pythonPath: `${missing}/not-installed-python`, modelDirectory: `${missing}/not-installed-model` } } } } });
    }, directory);
    await page.reload(); await page.getByRole('button', { name: '新建对话', exact: true }).click();
    await page.getByPlaceholder('随心输入').fill('给我念一首英文诗和一首中文诗');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.getByText('本机神经语音暂时不可用，请检查模型目录及 Python 运行环境。', { exact: true })).toBeVisible();
    await expect(page.getByText(/Error invoking remote method|已安装所选系统声音/u)).toHaveCount(0);
    const status = await page.evaluate(() => window.desktopAgent.getSpeechStatus());
    expect(status.playbacks.some(state => state.state === 'playing' || state.state === 'played')).toBe(false);
    expect(status.diagnostics!.tts.failed).toBe(1);
  } finally { await app.close(); }
});
