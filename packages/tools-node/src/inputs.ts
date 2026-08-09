import { z } from 'zod';

export const ReadFileInput = z.object({
  path: z.string().min(1)
});

export const ListFilesInput = z.object({
  path: z.string().default('.'),
  depth: z.number().int().min(0).max(5).default(3)
});

export const TerminalInput = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).max(100).default([]),
  cwd: z.string().default('.'),
  timeoutMs: z.number().int().min(1_000).max(300_000).default(120_000)
});
