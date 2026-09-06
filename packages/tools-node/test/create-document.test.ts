import { describe, expect, it } from 'vitest';
import { CreateDocumentTool } from '../src/create-document-tool';
import { DefaultPermissionGate } from '../src/default-permission-gate';

describe('create_document', () => {
  it('creates a conversation document without requiring a workspace or filesystem approval', async () => {
    const input = { name: '报告.html', content: '<!doctype html><h1>报告</h1>' };
    expect(await new DefaultPermissionGate().check({ id: 'doc', name: 'create_document', input }, {
      sessionId: 'test', workingDirectory: '/nonexistent/workspace'
    })).toEqual({ decision: 'allow' });
    const result = await new CreateDocumentTool().execute(input);
    expect(result.ok).toBe(true);
    expect(result.content).toContain('no file has been written');
  });

  it.each(['../report.html', '/tmp/report.html', 'C:\\report.html', 'report.exe', 'bad\n.html'])('rejects unsafe names: %s', async (name) => {
    await expect(new CreateDocumentTool().execute({ name, content: '<h1>Report</h1>' })).rejects.toThrow();
  });
});
