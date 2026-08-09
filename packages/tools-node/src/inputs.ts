import { z } from 'zod';

export const ReadFileInput = z.object({
  path: z.string().min(1)
});

export const ListFilesInput = z.object({
  path: z.string().default('.'),
  depth: z.number().int().min(0).max(5).default(3)
});

export const TerminalInput = z.object({
  command: z.string().min(1).refine(
    (value) => !/\s/.test(value),
    'command must contain only the executable name or path. Put every argument in the args array.'
  ),
  args: z.array(z.string()).max(100).default([]),
  cwd: z.string().default('.'),
  timeoutMs: z.number().int().min(1_000).max(300_000).default(120_000)
});

const FileContent = z.string().max(2_000_000);

export const WriteFileInput = z.object({
  path: z.string().min(1),
  content: FileContent
});

export const EditFileInput = z.object({
  path: z.string().min(1),
  oldText: z.string().min(1).max(1_000_000),
  newText: FileContent,
  replaceAll: z.boolean().default(false)
});

export const DeleteFileInput = z.object({
  path: z.string().min(1)
});

export const GlobInput = z.object({
  pattern: z.string().min(1).max(500),
  path: z.string().default('.'),
  maxResults: z.number().int().min(1).max(1_000).default(200)
});

export const GrepInput = z.object({
  query: z.string().min(1).max(10_000),
  path: z.string().default('.'),
  glob: z.string().min(1).max(500).optional(),
  caseSensitive: z.boolean().default(false),
  maxResults: z.number().int().min(1).max(1_000).default(200)
});
