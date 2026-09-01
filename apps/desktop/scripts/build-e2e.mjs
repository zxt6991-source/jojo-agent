import { build } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(desktopRoot, '../..');
const buildDirectory = path.join(desktopRoot, '.vite', 'build');
const aliases = {
  '@desktop-agent/agent-runtime/spi': path.join(repositoryRoot, 'packages/agent-runtime/src/spi/index.ts'),
  '@desktop-agent/agent-runtime': path.join(repositoryRoot, 'packages/agent-runtime/src/index.ts'),
  '@desktop-agent/browser-automation': path.join(repositoryRoot, 'packages/browser-automation/src/index.ts'),
  '@desktop-agent/channel-core/testing': path.join(repositoryRoot, 'packages/channel-core/src/testing.ts'),
  '@desktop-agent/channel-adapters': path.join(repositoryRoot, 'packages/channel-adapters/src/index.ts'),
  '@desktop-agent/channel-core': path.join(repositoryRoot, 'packages/channel-core/src/index.ts'),
  '@desktop-agent/channel-runtime': path.join(repositoryRoot, 'packages/channel-runtime/src/index.ts'),
  '@desktop-agent/contracts/runtime': path.join(repositoryRoot, 'packages/contracts/src/runtime.ts'),
  '@desktop-agent/contracts': path.join(repositoryRoot, 'packages/contracts/src/index.ts'),
  '@desktop-agent/hooks': path.join(repositoryRoot, 'packages/hooks/src/index.ts'),
  '@desktop-agent/memory': path.join(repositoryRoot, 'packages/memory/src/index.ts'),
  '@desktop-agent/runtime-composition': path.join(repositoryRoot, 'packages/runtime-composition/src/index.ts'),
  '@desktop-agent/scheduler': path.join(repositoryRoot, 'packages/scheduler/src/index.ts')
};
const external = ['electron', 'bufferutil', 'utf-8-validate', /^node:/u, ...builtinModules];
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
