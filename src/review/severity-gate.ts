import { Finding, SEVERITY_ORDER, Severity } from '../core/types/finding';

export type FailOn = Severity | 'never';

/**
 * Whether a review should fail the build.
 *
 * Severity is ordered with `critical` at 0, so "at or above the threshold" is a
 * `<=` on the rank — the direction that reads backwards and is worth stating.
 *
 * Only findings the grounding guard KEPT are considered. A structural claim that cited
 * nothing was never shown to anyone, and failing a build on a finding the tool itself
 * suppressed would be indefensible.
 */
export function shouldFail(findings: Finding[], failOn: FailOn): boolean {
  if (failOn === 'never') return false;
  const threshold = SEVERITY_ORDER[failOn];
  return findings.some((finding) => SEVERITY_ORDER[finding.severity] <= threshold);
}

/** The findings that tripped the gate, for the message explaining the exit code. */
export function blockingFindings(findings: Finding[], failOn: FailOn): Finding[] {
  if (failOn === 'never') return [];
  const threshold = SEVERITY_ORDER[failOn];
  return findings.filter((finding) => SEVERITY_ORDER[finding.severity] <= threshold);
}
