import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import path from 'node:path';

export async function launchElectron(dataDirectory: string): Promise<{ app: ElectronApplication; page: Page }> {
  const desktopRoot = path.resolve(process.cwd());
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const electronApp = await electron.launch({
    args: [desktopRoot],
    env: { ...env, JOJO_E2E: '1', JOJO_E2E_DATA_DIR: dataDirectory }
  });
  electronApp.process().stdout?.on('data', (chunk) => process.stdout.write(`[electron] ${String(chunk)}`));
  electronApp.process().stderr?.on('data', (chunk) => process.stderr.write(`[electron] ${String(chunk)}`));
  const page = await electronApp.firstWindow();
  page.on('console', (message) => console.log(`[renderer:${message.type()}] ${message.text()}`));
  page.on('pageerror', (error) => console.error(`[renderer:error] ${error.message}`));
  await page.waitForLoadState('domcontentloaded');
  return { app: electronApp, page };
}
