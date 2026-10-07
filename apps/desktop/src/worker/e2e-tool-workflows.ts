import type { ModelRequest, ToolCall, ToolResult } from '@desktop-agent/contracts';

/** Deterministic model decisions only: every effect still enters the real tool pipeline. */
export function e2eToolWorkflow(request: ModelRequest): { call?: ToolCall; text?: string } | undefined {
  let start = 0;
  request.messages.forEach((message, index) => { if (message.role === 'user' && !message.metadata?.internal) start = index; });
  const user = request.messages[start];
  const prompt = user?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') ?? '';
  const results = request.messages.slice(start).flatMap(message => message.content.flatMap(block => block.type === 'tool_result' ? [block.result] : []));
  const prefix = `e2e-${user?.id.slice(0, 36)}`;
  const call = (key: string, name: string, input: unknown) => ({ call: { id: `${prefix}-${key}`, name, input } });
  const result = (key: string) => results.find(value => value.callId === `${prefix}-${key}`);
  const object = (value?: ToolResult): Record<string, unknown> => value?.structuredResult && typeof value.structuredResult === 'object' && !Array.isArray(value.structuredResult) ? value.structuredResult as Record<string, unknown> : {};
  if (prompt.includes('E2E: single file journal')) {
    const name = prompt.includes('delete_file') ? 'delete_file' : prompt.includes('edit_file') ? 'edit_file' : 'write_file';
    if (!result('read')) return call('read', 'read_file', { path: 'single.txt' });
    if (!result('mutation')) return call('mutation', name, name === 'write_file' ? { path: 'single.txt', content: 'after-single' } : name === 'edit_file' ? { path: 'single.txt', oldText: 'before-single', newText: 'after-single' } : { path: 'single.txt' });
    const journalId = object(result('mutation')).journalId;
    if (journalId && !result('undo')) return call('undo', 'file_undo', { journalId, action: 'undo' });
    if (journalId && result('undo')?.ok && !result('redo')) return call('redo', 'file_undo', { journalId, action: 'redo' });
    return { text: 'single file journal settled' };
  }
  if (prompt.includes('E2E: patch journal')) {
    if (!result('read-a')) return call('read-a', 'read_file', { path: 'a.txt' });
    if (!result('read-b')) return call('read-b', 'read_file', { path: 'b.txt' });
    if (!result('patch')) return call('patch', 'apply_patch', { changes: [{ operation: 'write', path: 'a.txt', content: 'after-a' }, { operation: 'write', path: 'b.txt', content: 'after-b' }] });
    const journalId = object(result('patch')).journalId;
    if (journalId && !result('undo')) return call('undo', 'file_undo', { journalId, action: 'undo' });
    if (journalId && result('undo')?.ok && !result('redo')) return call('redo', 'file_undo', { journalId, action: 'redo' });
    return { text: 'patch journal settled' };
  }
  if (prompt.includes('E2E: long result')) {
    if (!result('long')) return call('long', 'terminal', { command: 'node', args: ['-e', 'console.log("x".repeat(20000)+"MIDDLE_ERROR: fixture failure"+"y".repeat(20000));process.exit(1)'] });
    if (!result('window') && !result('long')?.content.includes('characters reclaimed')) return { text: 'expected context projection missing' };
    if (!result('window')) return call('window', 'result_read', { callId: `${prefix}-long`, offset: 19950, limit: 250 });
    return { text: result('window')?.content.includes('MIDDLE_ERROR') ? 'middle error recovered from original result' : 'middle error evidence unavailable' };
  }
  if (prompt.includes('E2E: history search')) {
    if (!result('search')) return call('search', 'session_search', { query: 'SQLite原始选择' });
    const hits = object(result('search')).hits;
    const hit = Array.isArray(hits) ? hits[0] : undefined;
    if (hit && !result('history-window')) return call('history-window', 'session_read_window', { sessionId: hit.sessionId, anchorSeq: hit.seq });
    return { text: hit ? 'history source recovered' : 'history source unavailable' };
  }
  if (prompt.includes('E2E: skill draft')) {
    if (!result('profile')) return call('profile', 'verification_profile', {});
    const batch = result('profile')?.verificationBatch;
    if (!batch) return { text: 'skill profile unavailable' };
    if (!result('batch')) return call('batch', 'verification_run', { batchId: batch.id });
    const checks = object(result('batch')).checks;
    const proof = Array.isArray(checks) ? checks.find(check => check.status === 'passed') : undefined;
    if (!proof) return { text: 'skill proof unavailable' };
    if (!result('draft')) return call('draft', 'skill_draft', { name: 'e2e-process', description: 'Offline tested process', trigger: 'Explicit offline fixture', inputs: 'Source files', outputs: 'Checked source', dependencies: [], steps: ['Run the configured check.'], knownFailures: 'Missing verification Profile.', validation: 'Require a current passed check.', platforms: ['macos'], sourceCallIds: [proof.callId], verificationCallId: proof.callId });
    const draft = object(result('draft')).draft;
    if (!draft || typeof draft !== 'object' || !('revision' in draft) || !('path' in draft)) return { text: 'skill draft unavailable' };
    if (!result('preview')) return call('preview', 'read_file', { path: draft.path });
    if (!result('activate')) return call('activate', 'skill_activate', { name: 'e2e-process', revision: draft.revision });
    return { text: 'skill draft reviewed' };
  }
  return undefined;
}
