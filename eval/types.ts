import { Category, Finding } from '../src/core/types/finding';

/**
 * A defect deliberately planted in a corpus repository.
 *
 * `kind` is what makes the headline claim measurable. A cross-module defect is one a
 * diff-only reviewer is structurally blind to — the change looks locally fine and breaks
 * something the diff never shows. A `local` defect is visible in the diff alone and acts
 * as the control: if graph context helps there too, the effect is "more context" rather
 * than "better context", which is a weaker claim than the one being made.
 */
export type DefectKind = 'cross-module' | 'cycle' | 'architecture' | 'local';

export interface KnownDefect {
  id: string;
  kind: DefectKind;
  /** Repo-relative file where a correct finding should land. */
  file: string;
  /** Line where it should land. */
  line: number;
  /** How far off that line a finding may be and still count. */
  lineTolerance: number;
  /** Categories that count as identifying this defect. */
  acceptCategories: Category[];
  /** For the scorecard, and for a human checking the corpus is fair. */
  description: string;
}

export interface CorpusCase {
  name: string;
  /** One sentence on what the change does, for the report. */
  summary: string;
  defects: KnownDefect[];
  /** Builds the repository and returns its path. Caller removes it. */
  build: () => { path: string };
}

export type Arm = 'grounded' | 'diff-only';

/** One review of one case by one arm. */
export interface RunOutcome {
  case: string;
  arm: Arm;
  run: number;
  findings: Finding[];
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  /** Set when the review could not be completed at all. */
  error?: string;
}

export interface MatchResult {
  /** Defect ids that at least one finding identified. */
  caught: string[];
  /** Defect ids nothing identified. */
  missed: string[];
  /** Findings that matched no known defect. */
  falsePositives: Finding[];
  /**
   * Findings that matched a defect already credited to an earlier finding.
   *
   * Counted as neither a hit nor a false positive: they are about a real problem, so
   * calling them wrong would punish a reviewer for being thorough, and crediting them
   * twice would let one repeated finding inflate recall.
   */
  duplicates: Finding[];
}
