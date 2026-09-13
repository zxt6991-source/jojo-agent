import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchElectron } from './helpers/launch-electron';

test('switches per-model context windows and preserves v4 metadata after restart', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-model-metadata-'));
  const models = [
    { id: 'small', discovered: { contextWindowTokens: 64_000, maxOutputTokens: 4_096, contextSource: 'provider', maxOutputSource: 'provider', discoveredAt: new Date().toISOString() }, defaultOutputTokens: 4_096 },
    { id: 'large', discovered: { contextWindowTokens: 1_000_000, maxOutputTokens: 128_000, contextSource: 'builtin', maxOutputSource: 'builtin', discoveredAt: new Date().toISOString() }, defaultOutputTokens: 8_192 }
  ];
  await writeFile(path.join(directory, 'config.json'), JSON.stringify({
    schemaVersion: 4, activeProviderId: 'openai',
    providers: [{ id: 'openai', name: 'Offline models', protocol: 'openai_chat_completions', baseUrl: 'https://example.test/v1', model: 'small', models }],
    utilityModel: { providerId: 'openai', model: 'small' }
  }));
  let launched = await launchElectron(directory);
  try {
    await launched.page.getByRole('button', { name: '新建对话' }).click();
    for (const [model, window] of [['small', '64k'], ['large', '1000k']]) {
      await launched.page.getByRole('combobox', { name: '本轮使用的模型' }).selectOption(model!);
      await launched.page.getByPlaceholder('随心输入').fill('E2E: text');
      await launched.page.getByRole('button', { name: '发送消息' }).click();
      await expect(launched.page.locator('.composer-context')).toContainText(`/ ${window}`);
      await expect(launched.page.getByRole('combobox', { name: '本轮使用的模型' })).toBeEnabled();
    }
    await launched.page.getByRole('button', { name: '⚙ 设置' }).click();
    await expect(launched.page.getByLabel('模型限制')).toContainText('Provider 自动检测');
    await launched.page.locator('#default-model').selectOption('large');
    await expect(launched.page.getByLabel('模型限制')).toContainText('Jojo 模型库');
    await launched.page.getByText('高级模型参数', { exact: true }).click();
    await launched.page.getByRole('spinbutton', { name: '默认输出预算（tokens）' }).fill('4096');
    await launched.page.getByRole('button', { name: '保存模型设置' }).click();
    await expect.poll(async () => launched.page.evaluate(async () => (await window.desktopAgent.getSettings()).providers[0]?.models[1]?.override?.defaultOutputTokens)).toBe(4_096);
    await launched.page.getByRole('button', { name: '恢复自动检测' }).click();
    await expect(launched.page.getByRole('spinbutton', { name: '默认输出预算（tokens）' })).toHaveValue('');
    await launched.page.getByRole('button', { name: '保存模型设置' }).click();
    await expect.poll(async () => launched.page.evaluate(async () => (await window.desktopAgent.getSettings()).providers[0]?.models[1]?.override)).toBeUndefined();
    await launched.page.getByRole('spinbutton', { name: '默认输出预算（tokens）' }).fill('4096');
    await launched.page.getByRole('button', { name: '保存模型设置' }).click();
    await expect.poll(async () => launched.page.evaluate(async () => (await window.desktopAgent.getSettings()).providers[0]?.models[1]?.override?.defaultOutputTokens)).toBe(4_096);
    await launched.app.close();
    launched = await launchElectron(directory);
    const saved = await launched.page.evaluate(() => window.desktopAgent.getSettings());
    expect(saved.providers[0]?.models[1]?.override).toEqual({ defaultOutputTokens: 4_096 });
    expect(saved.providers[0]?.models.map((model) => model.discovered.contextWindowTokens)).toEqual([64_000, 1_000_000]);
    const raw = await readFile(path.join(directory, 'config.json'), 'utf8');
    expect(JSON.parse(raw).schemaVersion).toBe(4);
    expect(raw).not.toContain('hasApiKey');
  } finally { await launched.app.close(); }
});

test('deduplicates discovery, preserves overrides and keeps cache after refresh failure', async () => {
  const { createServer } = await import('node:http');
  let requests = 0;
  let fail = false;
  const server = createServer((_request, response) => {
    requests += 1;
    setTimeout(() => {
      response.writeHead(fail ? 503 : 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(fail ? { error: 'offline' } : { data: [
        { id: 'remote', context_length: 64_000, max_output_tokens: 4_096 }
      ] }));
    }, 50);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing local server address');
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-discovery-'));
  const launched = await launchElectron(directory);
  try {
    const results = await launched.page.evaluate(async (baseUrl) => {
      const settings = await window.desktopAgent.getSettings();
      const provider = settings.providers[0]!;
      provider.baseUrl = baseUrl;
      provider.models[0]!.override = { defaultOutputTokens: 1_024 };
      await window.desktopAgent.saveSettings({ activeProviderId: provider.id, provider, utilityModel: settings.utilityModel, apiKey: 'offline-test-key' });
      const input = { providerId: provider.id, protocol: provider.protocol, baseUrl };
      await Promise.all([window.desktopAgent.listModels(input), window.desktopAgent.listModels(input)]);
      return window.desktopAgent.getSettings();
    }, baseUrl);
    expect(requests).toBe(1);
    expect(results.providers[0]?.models.find((model) => model.id === 'remote')?.discovered.contextWindowTokens).toBe(64_000);
    expect(results.providers[0]?.models.find((model) => model.id === 'gpt-5-mini')).toMatchObject({ override: { defaultOutputTokens: 1_024 }, discovered: { unavailable: true } });
    fail = true;
    const afterFailure = await launched.page.evaluate(async (baseUrl) => {
      try { await window.desktopAgent.listModels({ providerId: 'openai', protocol: 'openai_chat_completions', baseUrl }); }
      catch { return window.desktopAgent.getSettings(); }
      throw new Error('Expected discovery failure');
    }, baseUrl);
    expect(afterFailure).toEqual(results);
  } finally {
    await launched.app.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
