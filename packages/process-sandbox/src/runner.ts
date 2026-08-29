import type { ProcessSandbox, SandboxMode, SandboxProbe, SandboxSpec } from './types.js';
import { LinuxBubblewrapSandbox } from './backends/linux-bwrap.js';
import { SoftProcessSandbox } from './backends/soft.js';
import { MacOSSandboxExecSandbox } from './backends/macos-sandbox-exec.js';

class UnsupportedPlatformStrongSandbox implements ProcessSandbox {
  async probe(): Promise<SandboxProbe> {
    return { available: false, strength: 'none', reason: `Strong process sandboxing is not implemented on ${process.platform}.` };
  }

  async spawn(): Promise<never> {
    throw Object.assign(new Error(`Strong process sandboxing is not implemented on ${process.platform}.`), { code: 'sandbox_unavailable' });
  }
}

function platformStrongSandbox(): ProcessSandbox {
  if (process.platform === 'darwin') return new MacOSSandboxExecSandbox();
  if (process.platform === 'linux') return new LinuxBubblewrapSandbox();
  return new UnsupportedPlatformStrongSandbox();
}

export class DefaultProcessSandbox implements ProcessSandbox {
  constructor(
    private readonly mode: SandboxMode = 'fallback',
    private readonly strong: ProcessSandbox = platformStrongSandbox(),
    private readonly soft: ProcessSandbox = new SoftProcessSandbox()
  ) {}

  async probe(): Promise<SandboxProbe> {
    if (this.mode === 'off') return { available: true, strength: 'none', reason: 'Sandboxing is disabled.' };
    const strong = await this.strong.probe();
    if (strong.available) return strong;
    if (this.mode === 'strict') return strong;
    return this.soft.probe();
  }

  async spawn(spec: SandboxSpec) {
    if (this.mode === 'off') return this.soft.spawn({ ...spec, fakeHome: false, tmpfs: false, network: { mode: 'host' } });
    const strong = await this.strong.probe();
    if (strong.available) return this.strong.spawn(spec);
    if (this.mode === 'strict') {
      throw Object.assign(new Error(strong.reason ?? 'Strong sandbox unavailable.'), { code: 'sandbox_unavailable' });
    }
    return this.soft.spawn(spec);
  }
}

export function createProcessSandbox(mode: SandboxMode = 'fallback'): ProcessSandbox {
  return new DefaultProcessSandbox(mode);
}
