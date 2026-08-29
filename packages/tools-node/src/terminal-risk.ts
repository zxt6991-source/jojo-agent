import path from 'node:path';
import type { TerminalCapability, TerminalRisk } from './terminal-security-policy.js';

const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe']);
const NETWORK_TOOLS = new Set(['curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'git', 'npm', 'pnpm', 'yarn', 'pip', 'pip3', 'cargo', 'go', 'npx', 'uvx']);
const DESTRUCTIVE_TOOLS = new Set(['rm', 'mv', 'chmod', 'chown', 'dd', 'kill', 'pkill']);

export type TerminalRiskClassification = {
  risk: TerminalRisk;
  capabilities: TerminalCapability[];
  reasons: string[];
};

export function classifyTerminalCommand(command: string): TerminalRiskClassification {
  const executable = path.basename(command).toLowerCase();
  const capabilities: TerminalCapability[] = ['workspace:read', 'workspace:write', 'process:spawn'];
  const reasons = ['The process can read and modify files in the current workspace.'];
  let risk: TerminalRisk = 'medium';
  if (SHELLS.has(executable)) {
    risk = 'high';
    reasons.push('A shell can interpret compound commands, but remains inside the selected sandbox.');
  }
  if (NETWORK_TOOLS.has(executable)) {
    risk = 'high';
    reasons.push('This executable commonly uses the network; outbound network access is denied by the default profile.');
  }
  if (DESTRUCTIVE_TOOLS.has(executable)) {
    risk = 'critical';
    reasons.push('This executable can perform destructive filesystem or process operations.');
  }
  return { risk, capabilities, reasons };
}
