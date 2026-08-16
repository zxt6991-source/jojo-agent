import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createBuiltinAgentProfileRegistry,
  loadAgentProfileDirectory,
  reloadAgentProfiles
} from '../src/index.js';

function profile(name: string, description: string, prompt: string, extra = ''): string {
  return `---\nname: ${name}\ndescription: ${description}\nreadOnly: true\n${extra}---\n\n${prompt}\n`;
}

describe('agent profile loader', () => {
  it('loads valid Markdown profiles and isolates invalid files', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-profiles-'));
    await writeFile(path.join(directory, 'security.md'), profile(
      'security', 'Security review', 'Inspect authentication and secret handling.',
      'allowedTools:\n  - read_file\n  - grep\n'
    ));
    await writeFile(path.join(directory, 'broken.md'), 'not frontmatter');

    const result = await loadAgentProfileDirectory(directory, 'user');

    expect(result.profiles).toMatchObject([{
      name: 'security', source: 'user', readOnly: true,
      allowedTools: ['read_file', 'grep'],
      systemPrompt: 'Inspect authentication and secret handling.'
    }]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({ filePath: path.join(directory, 'broken.md') });
  });

  it('applies project > user > builtin precedence and reloads without mutating running copies', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-profile-project-'));
    const userDirectory = path.join(root, 'user');
    const projectRoot = path.join(root, 'project');
    const projectDirectory = path.join(projectRoot, '.jojo', 'agents');
    await mkdir(userDirectory, { recursive: true });
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(path.join(userDirectory, 'explore.md'), profile('explore', 'User explorer', 'User prompt.'));
    await writeFile(path.join(projectDirectory, 'explore.md'), profile('explore', 'Project explorer', 'Project prompt.'));

    const registry = createBuiltinAgentProfileRegistry();
    await reloadAgentProfiles(registry, { userDirectory, projectRoot });

    expect(registry.get('explore').source).toBe('user');
    expect(registry.get('explore', projectRoot)).toMatchObject({ source: 'project', systemPrompt: 'Project prompt.' });
    const runningCopy = registry.get('explore', projectRoot);
    await writeFile(path.join(projectDirectory, 'explore.md'), profile('explore', 'Project explorer v2', 'Updated project prompt.'));
    await reloadAgentProfiles(registry, { projectRoot });
    expect(registry.get('explore', projectRoot).systemPrompt).toBe('Updated project prompt.');
    expect(runningCopy.systemPrompt).toBe('Project prompt.');
  });

  it('rejects name/file mismatches without hiding other profiles', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-profile-names-'));
    await writeFile(path.join(directory, 'wrong.md'), profile('different', 'Mismatch', 'Prompt.'));
    await writeFile(path.join(directory, 'valid.md'), profile('valid', 'Valid', 'Valid prompt.'));

    const result = await loadAgentProfileDirectory(directory, 'project');

    expect(result.profiles.map((item) => item.name)).toEqual(['valid']);
    expect(result.warnings[0]?.message).toContain('must match its file name');
  });
});
