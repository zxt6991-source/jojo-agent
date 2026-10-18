import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { SpeechSidecarClient, type SpeechSidecarTransport } from '@desktop-agent/speech';

export interface SpeechSidecarHostOptions {
  pythonPath: string; scriptPath: string; vadModel?: string; paraformerDirectory?: string; smartTurnModel?: string;
  prepare?(): Promise<void>;
}
/** Explicitly constructed by a host experiment, never during app startup.
 * Missing local models report unavailable; this class never downloads them. */
export function createSpeechSidecarHost(options: SpeechSidecarHostOptions): SpeechSidecarClient {
  if (!options.pythonPath || options.pythonPath.includes('\0') || !isAbsolute(options.scriptPath)) throw new Error('invalid_speech_sidecar_paths');
  return new SpeechSidecarClient({ connect: async () => {
    await options.prepare?.();
    const args = ['-u', options.scriptPath, '--vad-stop-secs', '0.2'];
    for (const [flag, value] of [['--vad-model', options.vadModel], ['--paraformer-dir', options.paraformerDirectory], ['--smart-turn-model', options.smartTurnModel]] as const) {
      if (value) { if (!isAbsolute(value) || value.includes('\0')) throw new Error('invalid_speech_model_path'); args.push(flag, value); }
    }
    const env: NodeJS.ProcessEnv = { PYTHONDONTWRITEBYTECODE: '1', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', USE_TORCH: '0', USE_TF: '0' };
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SystemRoot']) if (process.env[key]) env[key] = process.env[key];
    const child = spawn(options.pythonPath, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, env });
    return new ProcessTransport(child);
  } });
}

class ProcessTransport implements SpeechSidecarTransport {
  private closed = false;
  private readonly chunks: Uint8Array[] = [];
  private bufferedBytes = 0;
  private receive: ((bytes: Uint8Array) => void) | undefined;
  private onClose: ((error?: Error) => void) | undefined;
  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    // Drain diagnostics without retaining raw third-party library output.
    child.stderr.resume();
    child.stdin.on('error', () => { /* Write callbacks report a controlled error. */ });
    child.stdout.on('data', (bytes: Buffer) => {
      if (this.closed) return;
      if (this.receive) this.receive(bytes);
      else if (this.bufferedBytes + bytes.length <= 1_048_576) { this.chunks.push(Uint8Array.from(bytes)); this.bufferedBytes += bytes.length; }
      else { this.onClose?.(new Error('speech_sidecar_output_limit')); void this.close(); }
    });
    child.once('error', () => { this.closed = true; this.onClose?.(new Error('speech_sidecar_spawn_failed')); });
    child.once('close', () => { const wasClosed = this.closed; this.closed = true; if (!wasClosed) this.onClose?.(new Error('speech_sidecar_disconnected')); });
  }
  subscribe(listener: (bytes: Uint8Array) => void, onClose: (error?: Error) => void): () => void {
    this.receive = listener; this.onClose = onClose;
    if (this.closed) onClose(new Error('speech_sidecar_disconnected'));
    else for (const bytes of this.chunks.splice(0)) listener(bytes);
    this.bufferedBytes = 0;
    return () => { this.receive = undefined; this.onClose = undefined; };
  }
  write(bytes: Uint8Array): Promise<void> {
    if (this.closed) return Promise.reject(new Error('speech_sidecar_closed'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('speech_sidecar_write_timeout')); void this.close(); }, 5000);
      this.child.stdin.write(bytes, error => { clearTimeout(timer); if (error) reject(new Error('speech_sidecar_write_failed')); else resolve(); });
    });
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true; this.receive = undefined; this.onClose = undefined; this.chunks.length = 0;
    this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy(); this.child.kill('SIGTERM');
    const force = setTimeout(() => this.child.kill('SIGKILL'), 1000);
    force.unref(); this.child.once('close', () => clearTimeout(force));
  }
}
