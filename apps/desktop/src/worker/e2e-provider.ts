import {
  type ModelProvider, type ModelRequest
} from '@desktop-agent/contracts';
import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface Context {
  dataDirectory: string;
}

export function createDesktopTestProvider(ctx: Context) {
  function latestUserText(request: ModelRequest): string {
    return [...request.messages].reverse().find((message) => message.role === 'user')?.content
      .filter((block) => block.type === 'text').map((block) => block.text).join('') ?? '';
  }

  function createE2eProvider(): ModelProvider {
    return {
      async *stream(request) {
        const prompt = latestUserText(request);
        if (prompt.includes('E2E: execution recovery')) {
          const marker = path.join(ctx.dataDirectory, 'e2e-resume-allowed');
          const recovered = await access(marker).then(() => true, () => false);
          await writeFile(path.join(ctx.dataDirectory, recovered ? 'e2e-request-after.json' : 'e2e-request-before.json'), JSON.stringify({
            model: request.model, maxOutputTokens: request.maxOutputTokens, instructions: request.instructions
          }));
          if (!recovered) await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }));
          if (request.signal.aborted) return;
          yield { type: 'text_delta' as const, text: 'execution recovered from original snapshot' };
          yield { type: 'response_completed' as const, stopReason: 'stop' };
          return;
        }
        if (prompt.includes('E2E: slow')) {
          await new Promise<void>((resolve) => {
            if (request.signal.aborted) { resolve(); return; }
            const timer = setTimeout(resolve, 60_000);
            request.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
          });
          return;
        }
        const hasToolResult = request.messages.some((message) => message.content.some((block) => block.type === 'tool_result'));
        if (prompt.includes('E2E: generated artifacts') && !hasToolResult) {
          for (const file of ['report.md', 'chart.svg', 'report.pdf']) {
            yield { type: 'tool_call_completed' as const, call: { id: `e2e-artifact-${crypto.randomUUID()}`, name: 'show_artifact', input: { path: file } } };
          }
          yield { type: 'response_completed' as const, stopReason: 'tool_calls' };
          return;
        }
        if (prompt.includes('E2E: generated document') && !hasToolResult) {
          yield {
            type: 'tool_call_completed' as const,
            call: {
              id: `e2e-document-${crypto.randomUUID()}`, name: 'create_document', input: {
                name: '稳健选股.html',
                content: '<!doctype html><html><head><style>h1 { color: rgb(12, 34, 56); }</style></head><body><h1>文档预览测试</h1><script>document.body.textContent="UNSAFE_SCRIPT"</script><img src="https://document-preview.invalid/tracker"></body></html>'
              }
            }
          };
          yield { type: 'response_completed' as const, stopReason: 'tool_calls' };
          return;
        }
        if (prompt.includes('E2E: channel tools') && !hasToolResult) {
          yield {
            type: 'tool_call_completed' as const,
            call: { id: `e2e-channel-${crypto.randomUUID()}`, name: 'channel_list_targets', input: {} }
          };
          yield { type: 'response_completed' as const, stopReason: 'tool_calls' };
          return;
        }
        if (prompt.includes('E2E: terminal secret') && !hasToolResult) {
          yield {
            type: 'tool_call_completed' as const,
            call: {
              id: `e2e-terminal-${crypto.randomUUID()}`,
              name: 'terminal',
              input: {
                command: 'node',
                args: ['-e', 'console.log(process.env.WEREAD_API_KEY)'],
                network: 'host',
                secretEnv: ['WEREAD_API_KEY']
              }
            }
          };
          yield { type: 'response_completed' as const, stopReason: 'tool_calls' };
          return;
        }
        if (prompt.includes('E2E: approval') && !hasToolResult) {
          const target = prompt.includes('deny') ? 'e2e-denied.txt' : 'e2e-approved.txt';
          yield {
            type: 'tool_call_completed' as const,
            call: { id: `e2e-write-${crypto.randomUUID()}`, name: 'write_file', input: { path: target, content: 'approved' } }
          };
          yield { type: 'response_completed' as const, stopReason: 'tool_calls' };
          return;
        }
        yield {
          type: 'text_delta' as const,
          text: prompt.includes('E2E: generated artifacts') ? '已生成 `report.md`、`chart.svg` 和 `report.pdf`。' : prompt.includes('E2E: channel tools')
            ? 'channel tools handled'
            : prompt.includes('E2E: terminal secret')
              ? 'terminal secret handled'
              : prompt.includes('E2E: approval') ? 'approval handled' : 'hello from offline e2e'
        };
        yield { type: 'response_completed' as const, stopReason: 'stop' };
      }
    };
  }


  return { createE2eProvider };
}
