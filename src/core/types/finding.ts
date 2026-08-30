import { z } from 'zod';

/**
 * The reviewer's output contract. The model is asked for exactly this shape; anything
 * that fails validation is sent back for repair rather than being silently coerced.
 */

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;

export const CATEGORIES = [
  'correctness',
  'cross-module-regression',
  'architecture',
  'circular-dependency',
  'security',
  'performance',
  'maintainability',
] as const;

export const findingSchema = z.object({
  severity: z.enum(SEVERITIES),
  category: z.enum(CATEGORIES),
  /** Repo-relative POSIX path the finding is anchored to. */
  file: z.string().min(1),
  /** 1-indexed. 0 means "the change as a whole", not a specific line. */
  line: z.number().int().min(0),
  summary: z.string().min(1).max(200),
  rationale: z.string().min(1),
  /**
   * Evidence ids (`E1`, `E7`) this finding rests on. Empty is legal for a purely local
   * correctness observation; a structural claim with no citation is rejected downstream.
   */
  evidenceRefs: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).optional(),
});

export const findingsPayloadSchema = z.object({
  findings: z.array(findingSchema),
});

export type Severity = (typeof SEVERITIES)[number];
export type Category = (typeof CATEGORIES)[number];
export type Finding = z.infer<typeof findingSchema>;
export type FindingsPayload = z.infer<typeof findingsPayloadSchema>;

/** Categories whose claims are structural, so a citation is mandatory. */
export const STRUCTURAL_CATEGORIES: readonly Category[] = [
  'cross-module-regression',
  'architecture',
  'circular-dependency',
];

export const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};
