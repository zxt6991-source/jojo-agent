import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchElectron } from './helpers/launch-electron';

test('uses the default model for background work after saving and restarting', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-default-background-model-'));
  const discovered = { contextSource: 'provider', maxOutputSource: 'provider', discoveredAt: new Date().toISOString(), contextWindowTokens: 64_000, maxOutputTokens: 4_096 };
  await writeFile(path.join(directory, 'config.json'), JSON.stringify({
    schemaVersion: 4, activeProviderId: 'openai',
    providers: [
      { id: 'openai', name: 'Chat provider', protocol: 'openai_chat_completions', baseUrl: 'https://example.test/v1', model: 'chat', models: [{ id: 'chat', discovered, defaultOutputTokens: 4_096 }, { id: 'deepseek-flash', discovered, defaultOutputTokens: 4_096 }] },
      { id: 'backup', name: 'Background provider', protocol: 'openai_chat_completions', baseUrl: 'https://background.test/v1', model: 'worker', models: [{ id: 'worker', discovered, defaultOutputTokens: 4_096 }] }
    ],
    utilityModel: { providerId: 'backup', model: 'worker' }
  }));
  let launched = await launchElectron(directory);
  try {
    await launched.page.getByRole('button', { name: '⚙ 设置' }).click();
    await expect(launched.page.getByRole('combobox', { name: '辅助模型', exact: true })).toHaveCount(0);
    await expect(launched.page.getByText('交流脉络、标题等后台整理也使用默认模型。')).toBeVisible();
    await launched.page.locator('#default-model').selectOption('deepseek-flash');
    await launched.page.getByRole('button', { name: '保存模型设置', exact: true }).click();
    await expect.poll(async () => launched.page.evaluate(async () => (await window.desktopAgent.getSettings()).utilityModel)).toEqual({ providerId: 'openai', model: 'deepseek-flash' });
    await launched.app.close();
    launched = await launchElectron(directory);
    await launched.page.getByRole('button', { name: '⚙ 设置' }).click();
    await expect(launched.page.locator('#default-model')).toHaveValue('deepseek-flash');
    const saved = await launched.page.evaluate(() => window.desktopAgent.getSettings());
    expect(saved.utilityModel).toEqual({ providerId: saved.activeProviderId, model: saved.providers[0]!.model });
    expect(saved.providers[1]!.model).toBe('worker');
  } finally { await launched.app.close(); }
});
