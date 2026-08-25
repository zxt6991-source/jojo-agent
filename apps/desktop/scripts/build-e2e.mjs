import { build } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(desktopRoot, '../..');
const buildDirectory = path.join(desktopRoot, '.vite', 'build');
const aliases = {
  '@desktop-agent/browser-automation': path.join(repositoryRoot, 'packages/browser-automation/src/index.ts'),
  '@desktop-agent/contracts': path.join(repositoryRoot, 'packages/contracts/src/index.ts'),
  '@desktop-agent/hooks': path.join(repositoryRoot, 'packages/hooks/src/index.ts'),
  '@desktop-agent/memory': path.join(repositoryRoot, 'packages/memory/src/index.ts')
};
const external = ['electron', ...builtinModules, ...builtinModules.map((module) => `node:${module}`)];
const define = {
  MAIN_WINDOW_VITE_DEV_SERVER_URL: 'undefined',
  MAIN_WINDOW_VITE_NAME: JSON.stringify('main_window')
};

async function buildNodeTarget(entry, filename, emptyOutDir) {
  await build({
    root: desktopRoot,
    resolve: { alias: aliases },
    define,
    build: {
      outDir: buildDirectory,
      emptyOutDir,
      sourcemap: true,
      target: 'node22',
      lib: { entry: path.join(desktopRoot, entry), formats: ['cjs'], fileName: () => filename },
      rollupOptions: { external }
    }
  });
}

await buildNodeTarget('src/main/main.ts', 'main.js', true);
await buildNodeTarget('src/preload/preload.ts', 'preload.js', false);
await buildNodeTarget('src/worker/worker.ts', 'worker.js', false);
await build({
  root: desktopRoot,
  base: './',
  plugins: [react()],
  resolve: { alias: { '@desktop-agent/contracts': aliases['@desktop-agent/contracts'] } },
  build: {
    outDir: path.join(desktopRoot, '.vite', 'renderer', 'main_window'),
    emptyOutDir: true,
    rollupOptions: { input: path.join(desktopRoot, 'index.html') }
  }
});
