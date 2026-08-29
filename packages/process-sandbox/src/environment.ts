import path from 'node:path';

const LOCALE_ENVIRONMENT = ['LANG', 'LC_ALL', 'LC_CTYPE', 'TERM'] as const;

export type SandboxEnvironmentOptions = {
  workingDirectory: string;
  home?: string;
  tmpDirectory?: string;
  source?: NodeJS.ProcessEnv;
  toolchainPaths?: string[];
};

/** Builds a deterministic environment. Host variables are not inherited except locale hints. */
export function createSandboxEnvironment(options: SandboxEnvironmentOptions): Record<string, string> {
  const source = options.source ?? process.env;
  const paths = [
    path.join(options.workingDirectory, 'node_modules', '.bin'),
    path.dirname(process.execPath),
    ...(options.toolchainPaths ?? []),
    ...(process.platform === 'win32'
      ? ['C:\\Windows\\System32', 'C:\\Windows']
      : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'])
  ];
  const environment: Record<string, string> = {
    PATH: [...new Set(paths)].join(path.delimiter),
    HOME: options.home ?? '/home/jojo',
    TMPDIR: options.tmpDirectory ?? '/tmp',
    PWD: options.workingDirectory
  };
  for (const name of LOCALE_ENVIRONMENT) {
    const value = source[name];
    if (value) environment[name] = value;
  }
  return environment;
}
