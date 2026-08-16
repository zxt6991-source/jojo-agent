import type { Tool } from '@desktop-agent/contracts';
import os from 'node:os';
import path from 'node:path';
import { DefaultPermissionGate } from './default-permission-gate.js';
import { DeleteFileTool, EditFileTool, WriteFileTool } from './file-tools.js';
import { FileSnapshotRegistry } from './file-snapshots.js';
import { GlobTool } from './glob-tool.js';
import { GrepTool } from './grep-tool.js';
import { ListFilesTool } from './list-files-tool.js';
import { ReadFileTool } from './read-file-tool.js';
import { TerminalTool } from './terminal-tool.js';
import { WebFetchTool } from './web-fetch-tool.js';
import { WebSearchTool } from './web-search-tool.js';

export { DefaultPermissionGate } from './default-permission-gate.js';
export { ListFilesTool } from './list-files-tool.js';
export { ReadFileTool } from './read-file-tool.js';
export {
  TerminalTool,
  createTerminalEnvironment,
  redactSensitiveEnvironmentAssignments
} from './terminal-tool.js';
export { DeleteFileTool, EditFileTool, WriteFileTool } from './file-tools.js';
export { FileSnapshotRegistry } from './file-snapshots.js';
export { GlobTool } from './glob-tool.js';
export { GrepTool } from './grep-tool.js';
export { WebFetchTool } from './web-fetch-tool.js';
export { WebSearchTool, createDefaultSearchBackends } from './web-search-tool.js';
export { htmlToMarkdown, parseBingHtml, parseDuckDuckGoHtml, stripHtml } from './web-html.js';
export {
  WEB_FETCH_INLINE_BYTES,
  WEB_FETCH_MAX_BYTES,
  buildWebFetchOutline,
  cleanupExpiredWebFetchFiles,
  formatWebFetchBytes,
  isWebFetchSpillPath,
  previewWebFetchContent,
  spillWebFetchContent,
  webFetchSpillDirectory
} from './web-fetch-storage.js';
export { UnsafeWebUrlError, assertSafeHttpUrl, isBlockedFetchAddress, parseHttpUrl } from './web-url.js';

export type DefaultToolOptions = {
  snapshots?: FileSnapshotRegistry;
  trashDirectory?: string;
};

export function createDefaultTools(options: DefaultToolOptions = {}): Tool[] {
  const snapshots = options.snapshots ?? new FileSnapshotRegistry();
  const trashDirectory = options.trashDirectory ?? path.join(os.tmpdir(), 'desktop-agent-trash');
  return [
    new ReadFileTool(undefined, snapshots),
    new ListFilesTool(),
    new GrepTool(),
    new GlobTool(),
    new WebSearchTool(),
    new WebFetchTool(),
    new WriteFileTool(snapshots, trashDirectory),
    new EditFileTool(snapshots, trashDirectory),
    new DeleteFileTool(snapshots, trashDirectory),
    new TerminalTool()
  ];
}

export function createDefaultToolRuntime(options: Omit<DefaultToolOptions, 'snapshots'> = {}): {
  tools: Tool[];
  permissionGate: DefaultPermissionGate;
} {
  const snapshots = new FileSnapshotRegistry();
  return {
    tools: createDefaultTools({ ...options, snapshots }),
    permissionGate: new DefaultPermissionGate(snapshots)
  };
}
