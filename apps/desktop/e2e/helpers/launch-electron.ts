import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

const desktopRoot = path.resolve(process.cwd());
// Resolve Electron from this package. Playwright otherwise `require`s it from
// playwright-core, which pnpm does not hoist to a place Node can find.
const desktopRequire = createRequire(path.join(desktopRoot, 'package.json'));

function resolvePackageRoot(name: string, from: string): string {
  return path.dirname(desktopRequire.resolve(`${name}/package.json`, { paths: [from] }));
}

function electronExecutablePath(): string {
  const executable = desktopRequire('electron') as unknown as string;
  if (typeof executable !== 'string' || !existsSync(executable)) {
    throw new Error(`Electron binary not found at ${String(executable)}. Install the desktop workspace with pnpm.`);
  }
  return executable;
}

function playwrightElectronLoaderPath(): string {
  const playwrightTest = resolvePackageRoot('@playwright/test', desktopRoot);
  const playwright = resolvePackageRoot('playwright', playwrightTest);
  const playwrightCore = resolvePackageRoot('playwright-core', playwright);
  const loader = path.join(playwrightCore, 'lib/server/electron/loader.js');
  if (!existsSync(loader)) {
    throw new Error(`Playwright Electron loader not found at ${loader}.`);
  }
  return loader;
}

export async function launchElectron(dataDirectory: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const electronApp = await electron.launch({
    executablePath: electronExecutablePath(),
    args: [
      '-r',
      playwrightElectronLoaderPath(),
      ...(process.platform === 'linux' ? ['--password-store=basic'] : []),
      ...(process.env.CI ? ['--disable-gpu'] : []),
      desktopRoot
    ],
    cwd: desktopRoot,
    env: { ...env, JOJO_E2E: '1', JOJO_E2E_DATA_DIR: dataDirectory, JOJO_ATTACHMENT_ROOT: path.join(dataDirectory, 'attachments', 'v1') }
  });
  electronApp.process().stdout?.on('data', (chunk) => process.stdout.write(`[electron] ${String(chunk)}`));
  electronApp.process().stderr?.on('data', (chunk) => process.stderr.write(`[electron] ${String(chunk)}`));
  const page = await electronApp.firstWindow();
  page.on('console', (message) => console.log(`[renderer:${message.type()}] ${message.text()}`));
  page.on('pageerror', (error) => console.error(`[renderer:error] ${error.message}`));
  await page.waitForLoadState('domcontentloaded');
  return { app: electronApp, page };
}
