import { chmod, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repository = path.resolve(packageDirectory, '../..');
const tsconfig = JSON.parse(await readFile(path.join(repository, 'tsconfig.base.json'), 'utf8'));
const aliases = new Map(Object.entries(tsconfig.compilerOptions.paths).map(([name, targets]) => [
  name,
  path.resolve(repository, targets[0])
]));
aliases.set('@desktop-agent/server', path.join(repository, 'apps/server/src/index.ts'));
const outputDirectory = path.join(packageDirectory, 'dist');
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

await build({
  entryPoints: [path.join(packageDirectory, 'src/bin.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  splitting: true,
  outdir: outputDirectory,
  entryNames: '[name]',
  chunkNames: 'chunks/[name]-[hash]',
  plugins: [{
    name: 'jojo-workspace-packages',
    setup(context) {
      context.onResolve({ filter: /^@desktop-agent\// }, (args) => {
        const target = aliases.get(args.path);
        return target ? { path: target } : undefined;
      });
      context.onResolve({ filter: /^[^./]/ }, (args) => ({ path: args.path, external: true }));
    }
  }]
});
await chmod(path.join(packageDirectory, 'dist/bin.js'), 0o755);
