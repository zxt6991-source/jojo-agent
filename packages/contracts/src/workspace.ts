import { z } from 'zod';

export const WorkspaceChangeSchema = z.object({
  path: z.string().min(1),
  status: z.enum(['added', 'modified', 'deleted', 'untracked']),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  patch: z.string(),
  truncated: z.boolean()
});
export type WorkspaceChange = z.infer<typeof WorkspaceChangeSchema>;

export const WorkspaceChangesSchema = z.object({
  isGitRepository: z.boolean(),
  files: z.array(WorkspaceChangeSchema),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  truncated: z.boolean()
});
export type WorkspaceChanges = z.infer<typeof WorkspaceChangesSchema>;
