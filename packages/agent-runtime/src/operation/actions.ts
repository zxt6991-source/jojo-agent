export type AgentAction =
  | { type: 'request_model' }
  | { type: 'request_model_without_tools' }
  | { type: 'request_approval'; callId: string }
  | { type: 'prepare_tool_effect'; callId: string }
  | { type: 'execute_tool'; callId: string }
  | { type: 'synthesize_interrupted_tool_result'; callId: string }
  | { type: 'advance_tool' }
  | { type: 'compact_context' }
  | { type: 'finish' };
