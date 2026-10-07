/** Availability of built-in host adapters, not whether an optional service is enabled. */
export const CAPABILITY_MANIFEST = [
  { id: 'runtime', version: 1, desktop: true, server: true, requiredAdapters: ['runtimeStore'] },
  { id: 'workflow', version: 1, desktop: true, server: false, requiredAdapters: ['workflowStore'] },
  { id: 'browser', version: 1, desktop: true, server: false, requiredAdapters: ['browserHost'] },
  { id: 'memory', version: 1, desktop: true, server: false, requiredAdapters: ['memoryStore'] },
  { id: 'subagents', version: 1, desktop: true, server: true, requiredAdapters: ['runtimeEnvironment'] },
  { id: 'images', version: 1, desktop: true, server: true, requiredAdapters: ['attachmentAccess'] },
  { id: 'approvals', version: 1, desktop: true, server: true, requiredAdapters: ['approvalHost'] },
  { id: 'scheduler', version: 1, desktop: true, server: true, requiredAdapters: ['scheduler'] },
  { id: 'channels', version: 1, desktop: true, server: true, requiredAdapters: ['channelManager'] }
] as const;

export type CapabilityId = typeof CAPABILITY_MANIFEST[number]['id'];
export type ScheduleTargetKind = 'agent' | 'workflow' | 'team_member';
export const SCHEDULER_TARGETS: Record<'desktop' | 'server', readonly ScheduleTargetKind[]> = {
  desktop: ['agent', 'workflow', 'team_member'],
  server: ['agent']
};

export function createServerCapabilityDefaults(options: {
  scheduler: boolean;
  channels: boolean;
  channelKinds: readonly string[];
}) {
  const supports = (id: CapabilityId): boolean => CAPABILITY_MANIFEST.some((item) => item.id === id && item.server);
  return {
    runtime: {
      lanes: true, resumeOperation: true, transcriptQuery: true, runQuery: true,
      steer: false, followUp: false, durableSuspend: false
    },
    workflow: supports('workflow'),
    browser: supports('browser'),
    memory: supports('memory'),
    subagents: supports('subagents'),
    images: supports('images'),
    approvals: supports('approvals'),
    scheduler: {
      enabled: options.scheduler,
      targets: options.scheduler ? [...SCHEDULER_TARGETS.server] : []
    },
    channels: {
      enabled: options.channels,
      kinds: options.channels ? [...options.channelKinds] : [],
      inbound: options.channels, outbound: options.channels, approvals: options.channels
    }
  };
}
