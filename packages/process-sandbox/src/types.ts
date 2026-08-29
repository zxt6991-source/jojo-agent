export type SandboxStrength = 'strong' | 'container' | 'soft' | 'none';

export type SandboxMode = 'strict' | 'fallback' | 'off';

export type SandboxMount = {
  path: string;
  target?: string;
  mode: 'ro' | 'rw';
};

export type NetworkPolicy =
  | { mode: 'none' }
  | { mode: 'allowlist'; hosts: string[] }
  | { mode: 'host' };

export type SandboxResourceLimits = {
  timeoutMs: number;
  maxOutputBytes: number;
  memoryBytes?: number;
  cpuTimeMs?: number;
  maxProcesses?: number;
};

export type SandboxSpec = {
  id: string;
  cwd: string;
  isolatedCwd?: boolean;
  command: string;
  args: string[];
  stdin?: 'ignore' | 'pipe';
  env: Record<string, string>;
  mounts: SandboxMount[];
  network: NetworkPolicy;
  fakeHome: boolean;
  tmpfs: boolean;
  resources: SandboxResourceLimits;
};

export type SandboxExit = {
  exitCode: number | null;
  signal?: string;
};

export type SandboxProcess = {
  readonly strength: SandboxStrength;
  readonly pid?: number;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  stdin?: NodeJS.WritableStream;
  wait(): Promise<SandboxExit>;
  terminate(): Promise<void>;
  kill(): Promise<void>;
};

export type SandboxProbe = {
  available: boolean;
  strength: SandboxStrength;
  reason?: string;
};

export interface ProcessSandbox {
  probe(): Promise<SandboxProbe>;
  spawn(spec: SandboxSpec): Promise<SandboxProcess>;
}
