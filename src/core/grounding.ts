import { EvidenceItem } from './types/evidence';
import { Finding, STRUCTURAL_CATEGORIES } from './types/finding';

export type GroundingRejectionReason = 'uncited-structural-claim' | 'unknown-evidence-ref';

export interface RejectedFinding {
  finding: Finding;
  reason: GroundingRejectionReason;
  /** The offending ids, for `unknown-evidence-ref`. */
  detail: string;
}

export interface GroundingResult {
  kept: Finding[];
  rejected: RejectedFinding[];
}

/**
 * The guard behind the project's central claim.
 *
 * Structural facts — what a change reaches, what cycle it creates, what layer it crosses —
 * come from the graph. The model reasons about them; it does not get to assert them. So a
 * structural finding that cites nothing, or that cites an evidence id we never supplied,
 * is dropped rather than reported: an invented call site presented with a citation is worse
 * than no finding at all, because it reads as verified.
 *
 * Non-structural findings (a local correctness or style observation) may stand uncited —
 * they are claims about the diff, which the model can see directly.
 */
export function enforceGrounding(findings: Finding[], evidence: EvidenceItem[]): GroundingResult {
  const knownIds = new Set(evidence.map((item) => item.id));
  const kept: Finding[] = [];
  const rejected: RejectedFinding[] = [];

  for (const finding of findings) {
    const unknown = finding.evidenceRefs.filter((ref) => !knownIds.has(ref));
    if (unknown.length > 0) {
      rejected.push({
        finding,
        reason: 'unknown-evidence-ref',
        detail: `cites ${unknown.join(', ')}, which was not in the context`,
      });
      continue;
    }

    const isStructural = STRUCTURAL_CATEGORIES.includes(finding.category);
    if (isStructural && finding.evidenceRefs.length === 0) {
      rejected.push({
        finding,
        reason: 'uncited-structural-claim',
        detail: `category "${finding.category}" requires at least one evidence citation`,
      });
      continue;
    }

    kept.push(finding);
  }

  return { kept, rejected };
}
