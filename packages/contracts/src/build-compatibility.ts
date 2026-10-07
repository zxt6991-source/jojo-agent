/** Current formats only. Compatibility with older versions requires migration tests. */
export const BUILD_COMPATIBILITY = {
  appVersion: '0.1.0',
  serverProtocol: 3,
  serverStateSchema: 6,
  configSchema: 4,
  sessionJsonlSchema: 1,
  runtimeContract: 1,
  runtimeSqliteSchema: 4,
  // Main/Worker validates messages but does not yet negotiate a version.
  desktopIpcProtocol: null
} as const;
