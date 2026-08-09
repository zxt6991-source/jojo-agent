import type { Tool } from '@desktop-agent/contracts';
import { ListFilesTool } from './list-files-tool.js';
import { ReadFileTool } from './read-file-tool.js';
import { TerminalTool } from './terminal-tool.js';

export { DefaultPermissionGate } from './default-permission-gate.js';
export { ListFilesTool } from './list-files-tool.js';
export { ReadFileTool } from './read-file-tool.js';
export { TerminalTool } from './terminal-tool.js';

export function createDefaultTools(): Tool[] {
  return [new ReadFileTool(), new ListFilesTool(), new TerminalTool()];
}
