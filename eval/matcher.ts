import { Finding } from '../src/core/types/finding';
import { KnownDefect, MatchResult } from './types';

/**
 * Decides whether a finding identified a planted defect.
 *
 * This function is the measurement, so how strict it is *is* the result. Three rules,
 * each chosen against a way of being wrong:
 *
 * **File must match exactly.** A finding about a different file is about a different
 * thing, however well it reads.
 *
 * **Line must be within the defect's tolerance.** Without this, any finding anywhere in
 * the right file scores — and since the corpus files are small, that is close to giving a
 * point for naming the file. Tolerance is per-defect because "the caller that silently
 * gets a default" is a specific line, while "this change closes an import cycle" is not.
 *
 * **Category must be one the defect accepts.** A finding that lands on the right line for
 * the wrong reason — "this variable could be renamed" at the site of a silent regression —
 * is not a catch. This is the rule that keeps the headline claim honest: without it, a
 * reviewer that produced one vague finding per file would score well.
 *
 * Deliberately NOT used: an LLM judge. Asking a model whether a model found the bug puts
 * the thing under measurement inside the measurement, and any disagreement between arms
 * then has two possible causes.
 */
export function matchFindings(findings: Finding[], defects: KnownDefect[]): MatchResult {
  const caught = new Set<string>();
  const falsePositives: Finding[] = [];
  const duplicates: Finding[] = [];

  for (const finding of findings) {
    const defect = defects.find((candidate) => identifies(finding, candidate));

    if (!defect) {
      falsePositives.push(finding);
      continue;
    }

    if (caught.has(defect.id)) {
      duplicates.push(finding);
      continue;
    }

    caught.add(defect.id);
  }

  return {
    caught: [...caught],
    missed: defects.filter((defect) => !caught.has(defect.id)).map((defect) => defect.id),
    falsePositives,
    duplicates,
  };
}

export function identifies(finding: Finding, defect: KnownDefect): boolean {
  if (normalise(finding.file) !== normalise(defect.file)) return false;
  if (!defect.acceptCategories.includes(finding.category)) return false;

  // Line 0 means "the change as a whole", which is a legitimate way to report a defect
  // whose nature is not a single line — an introduced cycle, a layering breach. It is
  // accepted only for defects whose tolerance says they are not line-specific.
  if (finding.line === 0) return defect.lineTolerance >= WHOLE_CHANGE_TOLERANCE;

  return Math.abs(finding.line - defect.line) <= defect.lineTolerance;
}

/**
 * A tolerance at or above this marks a defect as not line-specific, so a whole-change
 * finding counts for it.
 */
export const WHOLE_CHANGE_TOLERANCE = 1000;

function normalise(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}
