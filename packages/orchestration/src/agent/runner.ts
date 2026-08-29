import type { LeafAgentRunner } from '../subagent/types.js';
import type { OrchestratedAgentRunner } from './types.js';

/** Compatibility adapter for orchestration code that still consumes LeafAgentRunner. */
export function createLeafAgentRunnerAdapter(runner: OrchestratedAgentRunner): LeafAgentRunner {
  return {
    laneBasedContinuation: true,
    run: async (request, signal, onEvent) => {
      const laneId = request.runtimeLane?.name ?? `agent:${request.id}`;
      const workflowLane = laneId.startsWith('workflow:') ? laneId.split(':') : undefined;
      const result = await runner.run({
        id: request.id,
        sessionId: request.sessionId,
        laneId,
        ...(request.runtimeLane?.parentLane ? { parentLaneId: request.runtimeLane.parentLane } : {}),
        workingDirectory: request.workingDirectory,
        task: request.task,
        actor: workflowLane
          ? {
              kind: 'workflow',
              id: request.id,
              profile: request.profile,
              workflowId: workflowLane[1] ?? request.id,
              ...(workflowLane[2] ? { stepId: workflowLane[2] } : {})
            }
          : { kind: 'subagent', id: request.id, profile: request.profile },
        profile: request.profile,
        providerId: request.providerId,
        model: request.model,
        maxIterations: request.maxIterations,
        timeoutMs: request.timeoutMs,
        ...(request.tools ? { tools: request.tools } : {}),
        ...(request.readOnly !== undefined ? { readOnly: request.readOnly } : {}),
        ...(request.outputSchema ? { outputSchema: request.outputSchema } : {}),
        ...(request.memoryBinding ? { memoryBinding: request.memoryBinding } : {}),
        ...(request.hooks ? { hooks: request.hooks } : {})
      }, signal, onEvent);
      return result;
    }
  };
}
