import { z } from 'zod';

export const reviewRequestSchema = z.object({
  /** Path to the repository working tree to analyse. */
  repoPath: z.string().min(1),
  baseRef: z.string().min(1).default('HEAD~1'),
  headRef: z.string().min(1).default('HEAD'),
  /** Skip the graph engine — the diff-only baseline the eval harness measures against. */
  diffOnly: z.boolean().default(false),
});

export type ReviewRequestDto = z.infer<typeof reviewRequestSchema>;
