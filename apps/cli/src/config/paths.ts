import os from 'node:os';
import path from 'node:path';

export function jojoHome(homeDirectory = os.homedir()): string {
  return path.join(homeDirectory, '.jojo');
}

export function defaultConfigPath(homeDirectory = os.homedir()): string {
  return path.join(jojoHome(homeDirectory), 'config.yml');
}

export function expandPath(value: string, options: { homeDirectory?: string; baseDirectory?: string } = {}): string {
  const homeDirectory = options.homeDirectory ?? os.homedir();
  if (value === '~') return homeDirectory;
  if (value.startsWith('~/')) return path.resolve(homeDirectory, value.slice(2));
  if (path.isAbsolute(value)) return path.normalize(value);
  return path.resolve(options.baseDirectory ?? process.cwd(), value);
}
