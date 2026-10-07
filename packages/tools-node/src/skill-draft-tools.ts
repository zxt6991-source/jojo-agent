import { createHash } from 'node:crypto';
import { z } from 'zod';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { Tool, ToolContext, ToolResult } from '@desktop-agent/contracts';
import { resolveWorkspacePath } from './workspace-paths.js';
import { WriteFileTool } from './file-tools.js';
import { FileSnapshotRegistry } from './file-snapshots.js';
const Name = z.string().regex(/^[a-z][a-z0-9-]{0,79}$/u);
const Text = z.string().trim().min(1).max(20000);
export const SkillDraftInput = z.object({
  name: Name, description: z.string().trim().min(1).max(500), trigger: Text,
  inputs: Text, outputs: Text, dependencies: z.array(z.string().max(500)).max(30),
  steps: z.array(Text).min(1).max(30), knownFailures: Text, validation: Text,
  platforms: z.array(z.string().min(1).max(100)).min(1).max(10),
  sourceCallIds: z.array(z.string().min(1).max(256)).min(1).max(20),
  verificationCallId: z.string().min(1).max(256),
  previousRevision: z.string().regex(/^[a-f0-9]{64}$/u).optional()
}).strict();
export const SkillActivateInput = z.object({ name: Name, revision: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
const DraftRecord = z.object({ schemaVersion: z.literal(1), revision: z.string().regex(/^[a-f0-9]{64}$/u), sessionId: z.string().min(1), draft: SkillDraftInput }).strict();
type Draft = z.infer<typeof SkillDraftInput>;
function checkPrivateValues(draft: Draft): void {
  const content = JSON.stringify(draft);
  if (/\bsk-[a-z0-9_-]{16,}|\bBearer\s+[a-z0-9._-]{12,}|(?:api[_-]?key|password|token|secret)\s*[=:]\s*["']?[^\s"',}]{8,}|\/Users\/[^/\s]+|\/home\/[^/\s]+|\/(?:tmp|private\/tmp|var\/folders)\/[^\s]+|[\w.+-]+@[\w.-]+\.[a-z]{2,}/iu.test(content)) throw Object.assign(new Error('Remove private credentials, usernames, email addresses and temporary paths before saving a reusable Skill.'), { code: 'skill_private_value' });
}
function revision(draft: Draft, sessionId: string): string { return createHash('sha256').update(JSON.stringify({ draft, sessionId })).digest('hex'); }
export function prepareSkillDraft(input: unknown, sessionId: string): { path: string; content: string; revision: string } {
  const draft = SkillDraftInput.parse(input); checkPrivateValues(draft);
  const version = revision(draft, sessionId);
  return { path: `.jojo/skill-drafts/${draft.name}/${version}.json`, content: JSON.stringify({ schemaVersion: 1, revision: version, sessionId, draft }, null, 2), revision: version };
}
export function skillDraftContent(record: z.infer<typeof DraftRecord>): string {
  const draft = record.draft;
  return `---\n${JSON.stringify({ name: draft.name, description: draft.description, metadata: { revision: record.revision, sourceSessionId: record.sessionId, sourceCallIds: draft.sourceCallIds, verificationCallId: draft.verificationCallId, ...(draft.previousRevision ? { previousRevision: draft.previousRevision } : {}), platforms: draft.platforms } }, null, 2)}\n---\n\n# ${draft.name}\n\n## When to use\n${draft.trigger}\n\n## Inputs\n${draft.inputs}\n\n## Outputs\n${draft.outputs}\n\n## Dependencies\n${draft.dependencies.map(item => `- ${item}`).join('\n') || 'None.'}\n\n## Procedure\n${draft.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}\n\n## Known failures\n${draft.knownFailures}\n\n## Validation\n${draft.validation}\n`;
}
export async function prepareSkillActivation(input: unknown, workingDirectory: string): Promise<{ path: string; content: string; revision: string }> {
  const parsed = SkillActivateInput.parse(input);
  const resolved = await resolveWorkspacePath(workingDirectory, `.jojo/skill-drafts/${parsed.name}/${parsed.revision}.json`);
  if (!resolved.inside) throw new Error('Skill draft is outside the workspace.');
  const file = await open(resolved.target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let content: string;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 500000) throw new Error('Invalid Skill draft size or file type.');
    const buffer = Buffer.alloc(500001); const read = await file.read(buffer, 0, buffer.length, 0);
    if (read.bytesRead > 500000) throw new Error('Skill draft exceeds the size limit.');
    content = buffer.subarray(0, read.bytesRead).toString('utf8');
  } finally { await file.close(); }
  const record = DraftRecord.parse(JSON.parse(content));
  checkPrivateValues(record.draft);
  if (record.draft.name !== parsed.name || record.revision !== parsed.revision || revision(record.draft, record.sessionId) !== parsed.revision) throw Object.assign(new Error('Skill draft revision mismatch.'), { code: 'skill_revision_mismatch' });
  return { path: `.agents/skills/${parsed.name}/SKILL.md`, content: skillDraftContent(record), revision: parsed.revision };
}
export class SkillDraftTool implements Tool {
  readonly replay = 'never' as const;
  readonly risk = 'write' as const;
  readonly definition = {
    name: 'skill_draft',
    description: 'Explicitly save a reusable verified process as a versioned project Skill draft under .jojo/skill-drafts, separate from active Skills. Requires approval. Include trigger, inputs/outputs, dependencies, procedure, known failures, validation, platform and original tool evidence. Requires a current passed verification result; do not promote unverified guesses. Prefer updating an existing topic, reading its current version first. Use read_file/list_files to preview drafts, delete_file to remove them, and skill_activate to review and activate a precise version. No automatic user-level installs.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, trigger: { type: 'string' }, inputs: { type: 'string' }, outputs: { type: 'string' }, dependencies: { type: 'array', items: { type: 'string' } }, steps: { type: 'array', items: { type: 'string' } }, knownFailures: { type: 'string' }, validation: { type: 'string' }, platforms: { type: 'array', items: { type: 'string' } }, sourceCallIds: { type: 'array', items: { type: 'string' } }, verificationCallId: { type: 'string' }, previousRevision: { type: 'string' } }, required: ['name', 'description', 'trigger', 'inputs', 'outputs', 'dependencies', 'steps', 'knownFailures', 'validation', 'platforms', 'sourceCallIds', 'verificationCallId'], additionalProperties: false }
  };
  constructor(private readonly snapshots: FileSnapshotRegistry, private readonly trashDirectory: string) {}
  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    if (!context.approved) return { callId: '', ok: false, code: 'permission_denied', content: 'Skill draft writing requires approval.' };
    const parsed = SkillDraftInput.parse(input);
    const proof = await context.readToolResult?.(parsed.verificationCallId);
    if (proof?.verification?.status !== 'passed' || !await context.isVerificationCurrent?.(parsed.verificationCallId)) return { callId: '', ok: false, code: 'skill_evidence_unverified', content: 'A current passed verification record is required.' };
    for (const id of parsed.sourceCallIds) if (!await context.readToolResult?.(id)) return { callId: '', ok: false, code: 'skill_evidence_missing', content: 'Source evidence is unavailable in this session branch.' };
    const prepared = prepareSkillDraft(parsed, context.sessionId);
    const result = await new WriteFileTool(this.snapshots, this.trashDirectory).execute(prepared, context);
    return { ...result, ...(result.ok ? { artifacts: [{ id: `skill-draft:${prepared.revision}`, name: `${parsed.name}.draft.md`, kind: 'markdown' as const, mimeType: 'text/markdown', source: 'generated' as const, storage: { type: 'conversation' as const, content: skillDraftContent({ schemaVersion: 1, revision: prepared.revision, sessionId: context.sessionId, draft: parsed }) }, version: 1, metadata: { state: 'draft', revision: prepared.revision } }] } : {}), structuredResult: { ...(result.structuredResult as Record<string, unknown> | undefined), draft: { name: parsed.name, revision: prepared.revision, path: prepared.path, state: 'draft' } } };
  }
}
export class SkillActivateTool implements Tool {
  readonly replay = 'never' as const;
  readonly risk = 'write' as const;
  readonly definition = {
    name: 'skill_activate',
    description: 'Activate an exact validated Skill draft revision in .agents/skills after reviewing its diff. Requires normal file-write approval. Read an existing target SKILL.md fully before updating it. Draft format, provenance and revision are checked. Later turns discover the active version. To roll back, activate a previously saved draft revision after reading the current file.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, revision: { type: 'string' } }, required: ['name', 'revision'], additionalProperties: false }
  };
  constructor(private readonly snapshots: FileSnapshotRegistry, private readonly trashDirectory: string) {}
  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    if (!context.approved) return { callId: '', ok: false, code: 'permission_denied', content: 'Skill activation requires approval.' };
    const prepared = await prepareSkillActivation(input, context.workingDirectory);
    const result = await new WriteFileTool(this.snapshots, this.trashDirectory).execute(prepared, context);
    return { ...result, structuredResult: { ...(result.structuredResult as Record<string, unknown> | undefined), skill: { path: prepared.path, revision: prepared.revision, state: 'active' } } };
  }
}
