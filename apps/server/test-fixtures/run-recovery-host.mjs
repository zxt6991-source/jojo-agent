import { URL } from 'node:url';
import { createJiti } from 'jiti';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const config = JSON.parse(readFileSync(new URL('../../../tsconfig.base.json', import.meta.url), 'utf8'));
const alias = Object.fromEntries(Object.entries(config.compilerOptions.paths).map(([name, targets]) => [name, path.resolve(targets[0])]));
const jiti = createJiti(import.meta.url, { alias });
await jiti.import('./recovery-host.ts');
