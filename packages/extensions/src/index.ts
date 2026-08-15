export { createSkillSource, discoverSkills, createSkillTool, parseSkillSource, skillId, userSkillDirectories } from './skills.js';
export { createInstallSkillTool } from './skill-installer.js';
export type { InstallSkillToolOptions, SkillInstallCommandRunner } from './skill-installer.js';
export type { DiscoveredSkill, SkillDirectory } from './skills.js';
export { McpManager } from './mcp-manager.js';
export type { McpClientConnection, McpConnectionEvents, McpConnectionFactory } from './mcp-manager.js';
export { DesktopMcpOAuthProvider } from './mcp-oauth.js';
export type { McpOAuthCredentials, McpOAuthProviderOptions } from './mcp-oauth.js';
export { ExtensionPermissionGate } from './permission-gate.js';
