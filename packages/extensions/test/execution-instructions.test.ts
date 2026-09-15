import { describe, expect, it } from 'vitest';
import { McpManager } from '../src/mcp-manager.js';
import type { McpServerConfig } from '@desktop-agent/contracts';

const config = (id: string): McpServerConfig => ({ id, name: id, enabled: true, transport: 'stdio', command: 'node', args: [], security: { allowInstructions: true } });
describe('durable MCP instruction contributions', () => {
  it('uses stable IDs and ordering across reconnects and removes disabled sources', async () => {
    const manager = new McpManager(() => undefined, async server => ({ instructions: `${server.id} instructions`, listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [] }), close: async () => undefined }));
    try {
      await manager.configure([config('a'), config('b')]);
      const original = manager.getInstructionContributions();
      await manager.configure([config('b'), config('a')]);
      expect(manager.getInstructionContributions()).toEqual(original);
      await manager.configure([{ ...config('a'), enabled: false }, config('b')]);
      expect(manager.getInstructionContributions()).toHaveLength(1);
      expect(manager.getInstructionContributions()[0]).toEqual(original.find(block => block.content.includes('b instructions')));
    } finally { await manager.close(); }
  });
  it('refuses oversized instructions instead of silently truncating', async () => {
    const manager = new McpManager(() => undefined, async () => ({ instructions: '中'.repeat(12000), listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [] }), close: async () => undefined }));
    try { await manager.configure([config('a')]); expect(() => manager.getInstructionContributions()).toThrow('runtime_execution_snapshot_too_large'); }
    finally { await manager.close(); }
  });
  it('does not persist a known credential returned in server instructions', async () => {
    const manager = new McpManager(() => undefined, async () => ({ instructions: 'echo CANARY-CREDENTIAL', listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [] }), close: async () => undefined }));
    try {
      await manager.configure([{ ...config('a'), transport: 'stdio', command: 'node', args: [], env: { API_KEY: 'CANARY-CREDENTIAL' } }]);
      expect(() => manager.getInstructionContributions()).toThrow('runtime_execution_snapshot_invalid: instructions.contributed');
    } finally { await manager.close(); }
  });
});
