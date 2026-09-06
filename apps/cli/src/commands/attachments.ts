import { collectAttachmentGarbage } from '@desktop-agent/attachments';

export async function attachmentsCommand(options: {
  root: string[]; source: string[]; graceDays: string; apply?: boolean; offline?: boolean;
}, output: NodeJS.WritableStream): Promise<void> {
  const days = Number(options.graceDays);
  if (!Number.isFinite(days) || days < 0) throw new Error('grace-days must be a non-negative number');
  const report = await collectAttachmentGarbage({
    roots: options.root, sources: options.source, graceMs: days * 86_400_000,
    apply: options.apply ?? false, offline: options.offline ?? false
  });
  output.write(JSON.stringify(report, null, 2) + '\n');
}
