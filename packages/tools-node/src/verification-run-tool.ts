import { z } from 'zod';
import { verificationEvidence, type Tool, type ToolContext, type ToolResult } from '@desktop-agent/contracts';
export const VerificationRunInput = z.object({ batchId: z.string().min(1).max(256), checkIds: z.array(z.string().min(1).max(128)).min(1).max(20).optional() }).strict();
export class VerificationRunTool implements Tool {
  readonly risk = 'external_side_effect' as const;
  readonly replay = 'never' as const;
  readonly definition = { name: 'verification_run', description: 'Run selected checkIds from a previously loaded verification_profile batch. Every command separately enters Terminal governance and approval, and shares the durable batch deadline including approval waits. No command can be added or changed here. Unknown effects are never replayed after interruption. Omitted checks remain skipped. Start a new profile batch explicitly after budget exhaustion.', inputSchema: { type: 'object', properties: { batchId: { type: 'string' }, checkIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 } }, required: ['batchId'], additionalProperties: false } };
  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const parsed = VerificationRunInput.parse(input);
    if (!context.runVerificationChecks) return { callId: '', ok: false, code: 'verification_unavailable', content: 'This Host does not support governed verification batches.' };
    const results = await context.runVerificationChecks({ batchId: parsed.batchId, ...(parsed.checkIds ? { checkIds: parsed.checkIds } : {}) });
    return { callId: '', ok: results.every(result => result.ok), content: JSON.stringify(results.map(result => ({ callId: result.callId, ok: result.ok, verification: result.verification ? verificationEvidence(result.verification) : undefined }))), structuredResult: { batchId: parsed.batchId, checks: results.map(result => ({ callId: result.callId, status: result.verification?.status ?? 'skipped', code: result.code ?? null })) } };
  }
}
