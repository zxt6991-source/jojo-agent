import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ModelProvider } from '@desktop-agent/contracts';
import { createSkillTool, discoverSkills } from '../../packages/extensions/src/skills.js';
import { ExtensionPermissionGate } from '../../packages/extensions/src/permission-gate.js';
import { ReadFileTool } from '../../packages/tools-node/src/read-file-tool.js';
import { DefaultPermissionGate } from '../../packages/tools-node/src/default-permission-gate.js';
import { executeScenario } from './fixture-runtime.js';

const Fixture = z.object({ version: z.literal(1), constraint: z.literal('CONSTRAINT_ONLY_READ'), noiseFiles: z.number().int().min(1).max(10), noiseCharacters: z.number().int().min(1000).max(12000), contextWindowTokens: z.number().int().min(4096).max(32000) }).strict();
export async function runSkillCompactionFixture(root: string, _storeDirectory: string, fixtureFile: string, timeoutMs: number) {
  const fixture = Fixture.parse(JSON.parse(await readFile(fixtureFile, 'utf8')));
  const directory = path.join(root, '.agents/skills/offline-read');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), `---\nname: offline-read\ndescription: Read only fixture inspection\n---\n\n${fixture.constraint}: Only use read_file. Do not modify files.\n${'Preserve the exact source revision and cite original evidence.\n'.repeat(50)}`);
  const skills = await discoverSkills([{ path: path.join(root, '.agents/skills'), origin: 'project' }]);
  const skill = skills.find(item => item.id === 'offline-read');
  if (!skill) throw new Error('Offline Skill discovery failed.');
  const expectedRevision = createHash('sha256').update(skill.content).digest('hex');
  const skillTool = createSkillTool(skills, { loadedSkillIds: new Set() });
  if (!skillTool) throw new Error('Offline Skill tool unavailable.');
  for (let index = 0; index < fixture.noiseFiles; index++) await writeFile(path.join(root, `noise-${index}.txt`), `${index}: ${'x'.repeat(fixture.noiseCharacters)}`);
  let stage = 0;
  let compactions = 0;
  let retainedAfterCompaction = false;
  const provider: ModelProvider = { async *stream(request) {
    const results = request.messages.flatMap(message => message.content.flatMap(block => block.type === 'tool_result' ? [block.result] : []));
    if (compactions > 0 && results.some(item => item.callId === 'skill' && item.content.includes(expectedRevision) && item.content.includes(fixture.constraint))) retainedAfterCompaction = true;
    if (stage === 0) yield { type: 'tool_call_completed', call: { id: 'skill', name: 'load_skill', input: { skillId: skill.id, revision: expectedRevision } } };
    else if (stage <= fixture.noiseFiles) yield { type: 'tool_call_completed', call: { id: `noise-${stage - 1}`, name: 'read_file', input: { path: `noise-${stage - 1}.txt` } } };
    else {
      const loaded = results.find(item => item.callId === 'skill');
      yield { type: 'text_delta', text: loaded?.ok && loaded.content.includes(fixture.constraint) ? `${fixture.constraint}: inspected source files without mutations.` : 'Constraint unavailable.' };
      yield { type: 'response_completed', stopReason: 'stop' }; return;
    }
    stage++;
    yield { type: 'response_completed', stopReason: 'tool_calls' };
  } };
  return executeScenario({ root, taskId: 'skill-compaction', timeoutMs, provider, tools: [skillTool, new ReadFileTool()],
    permissions: new ExtensionPermissionGate(new DefaultPermissionGate()), budget: { contextWindowTokens: fixture.contextWindowTokens, maxOutputTokens: 1024 },
    observe: ({ event }) => { if (event.type === 'context.compacted') compactions++; },
    verify: async (result, results, messages) => {
      const initial = results.find(item => item.callId === 'skill');
      const calls = messages.flatMap(message => message.content.flatMap(block => block.type === 'tool_call' ? [block.call] : []));
      const preserved = (await readFile(path.join(directory, 'SKILL.md'), 'utf8')) === skill.content;
      return { criteria: [
        { id: 'exact-skill-revision', passed: compactions > 0 && retainedAfterCompaction && initial?.ok === true && initial.content.includes(expectedRevision) && preserved, evidence: 'trace.json#skill' },
        { id: 'constraint-preserved', passed: compactions > 0 && calls.every(call => ['load_skill', 'read_file'].includes(call.name)) && (result.finalText ?? '').includes(fixture.constraint), evidence: 'trace.json#finalText' }
      ], evidence: { skill: { expectedRevision, compactions, retainedAfterCompaction, preserved } } };
    }
  });
}
