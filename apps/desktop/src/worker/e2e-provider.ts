import {
  type ModelProvider, type ModelRequest
} from '@desktop-agent/contracts';
import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { e2eToolWorkflow } from './e2e-tool-workflows';

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
        if (prompt === '给我念一首英文诗和一首中文诗') {
          const complete = request.instructions?.some(value => value.includes('用户在本轮明确请求出声朗读') && value.includes('保留原文全部句子'));
          yield { type: 'text_delta', text: complete ? [
            '# Morning Light',
            'The morning light returns to every window. A quiet river carries leaves away.',
            'Across the fields a little bird is calling. The open road is waiting for the day.',
            'We walk beside the water in the sunlight. We watch the clouds move slowly through the blue.',
            'The trees are waking gently in the garden. Another morning brings a path anew.',
            '# 晨光',
            '晨光越过窗前的小树，清风翻开安静的书页。河水带着落叶向前，远山披着淡淡的云。',
            '我们沿着小路慢慢走，看见草尖闪亮的露珠。鸟儿唱起今天的歌，阳光落在每一朵花上。',
            '不必急着追赶远方，也不必数昨天的脚步。把这一路的微光收好，让新的清晨陪我们出发。'
          ].join('\n\n') : '离线断言失败：没有收到本轮全文朗读指令。' };
          yield { type: 'response_completed', stopReason: 'stop' }; return;
        }
        if (prompt === '你给我朗读春花秋月何时了这首词' || prompt === '开始念') {
          const enabled = request.instructions?.some(value => value.includes('客户端已启用本地 TTS 朗读'));
          const complete = request.instructions?.some(value => value.includes('用户在本轮明确请求出声朗读') && value.includes('保留原文全部句子'));
          yield { type: 'text_delta', text: enabled && complete
            ? '春花秋月何时了？往事知多少。\n小楼昨夜又东风，故国不堪回首月明中。\n雕栏玉砌应犹在，只是朱颜改。\n问君能有几多愁？恰似一江春水向东流。'
            : '离线断言失败：没有收到启用状态或本轮全文朗读指令。' };
          yield { type: 'response_completed', stopReason: 'stop' }; return;
        }
        const workflow = e2eToolWorkflow(request);
        if (workflow) {
          if (workflow.call) yield { type: 'tool_call_completed', call: workflow.call };
          else if (workflow.text) yield { type: 'text_delta', text: workflow.text };
          yield { type: 'response_completed', stopReason: workflow.call ? 'tool_calls' : 'stop' }; return;
        }
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
        if (prompt.includes('E2E: long speech')) {
          yield { type: 'text_delta', text: '这是用于验证分段继续朗读的离线文本。'.repeat(75) };
          yield { type: 'response_completed', stopReason: 'stop' }; return;
        }
        if (prompt.includes('E2E: verification batch')) {
          let start = 0;
          request.messages.forEach((message, index) => { if (message.role === 'user' && message.content.some(block => block.type === 'text' && block.text.includes('E2E: verification batch'))) start = index; });
          const results = request.messages.slice(start).flatMap(message => message.content.flatMap(block => block.type === 'tool_result' ? [block.result] : []));
          const batch = results.find(result => result.verificationBatch)?.verificationBatch;
          if (!batch) yield { type: 'tool_call_completed', call: { id: `e2e-profile-${crypto.randomUUID()}`, name: 'verification_profile', input: {} } };
          else if (!results.some(result => result.structuredResult && typeof result.structuredResult === 'object' && 'batchId' in result.structuredResult)) {
            yield { type: 'tool_call_completed', call: { id: `e2e-batch-${crypto.randomUUID()}`, name: 'verification_run', input: { batchId: batch.id } } };
          } else {
            yield { type: 'text_delta', text: 'verification batch settled' };
            yield { type: 'response_completed', stopReason: 'stop' }; return;
          }
          yield { type: 'response_completed', stopReason: 'tool_calls' }; return;
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
