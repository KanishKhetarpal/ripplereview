import { Arm, DefectKind, KnownDefect, MatchResult, RunOutcome } from './types';

export interface CountSet {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  duplicates: number;
}

export interface Rates {
  precision: number;
  recall: number;
  f1: number;
}

export interface Spread {
  mean: number;
  stdev: number;
  min: number;
  max: number;
  n: number;
}

/**
 * Counts for one review.
 *
 * A defect is credited once however many findings identify it, and the extras are counted
 * as neither hit nor miss — see `MatchResult.duplicates`.
 */
export function countsFor(match: MatchResult): CountSet {
  return {
    truePositives: match.caught.length,
    falsePositives: match.falsePositives.length,
    falseNegatives: match.missed.length,
    duplicates: match.duplicates.length,
  };
}

/**
 * Precision, recall and F1 from raw counts.
 *
 * The zero cases are the ones worth being explicit about, because they are common in a
 * small corpus and a naive division makes them NaN, which then poisons every mean that
 * touches it:
 *
 * - No findings at all: precision is 1 by convention (nothing wrong was said) and recall
 *   is 0. A reviewer that says nothing is perfectly precise and useless, which F1 then
 *   correctly reports as 0.
 * - No defects to find (the clean-refactor case): recall is 1 — everything there was to
 *   find was found — and precision falls to whatever share of findings were spurious.
 */
export function ratesFor(counts: CountSet): Rates {
  const predicted = counts.truePositives + counts.falsePositives;
  const actual = counts.truePositives + counts.falseNegatives;

  const precision = predicted === 0 ? 1 : counts.truePositives / predicted;
  const recall = actual === 0 ? 1 : counts.truePositives / actual;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return { precision, recall, f1 };
}

/**
 * Recall restricted to the defects a diff-only reviewer is structurally blind to.
 *
 * This is the headline number. Overall recall mixes in local defects, which both arms can
 * see, and that dilutes exactly the difference the project claims to create.
 */
export const CROSS_MODULE_KINDS: readonly DefectKind[] = ['cross-module', 'cycle', 'architecture'];

export function crossModuleRecall(match: MatchResult, defects: KnownDefect[]): number | null {
  const relevant = defects.filter((defect) => CROSS_MODULE_KINDS.includes(defect.kind));
  if (relevant.length === 0) return null;

  const caught = relevant.filter((defect) => match.caught.includes(defect.id)).length;
  return caught / relevant.length;
}

/**
 * Mean and spread across repeated runs.
 *
 * Reported rather than averaged away because the thing being measured is not deterministic
 * even at temperature 0. A single run of each arm is an anecdote, and two means that
 * differ by less than their spread are not a result.
 */
export function spread(values: number[]): Spread {
  if (values.length === 0) return { mean: 0, stdev: 0, min: 0, max: 0, n: 0 };

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  // Population standard deviation: these are all the runs performed, not a sample of them.
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;

  return {
    mean,
    stdev: Math.sqrt(variance),
    min: Math.min(...values),
    max: Math.max(...values),
    n: values.length,
  };
}

export interface ArmSummary {
  arm: Arm;
  precision: Spread;
  recall: Spread;
  f1: Spread;
  crossModuleRecall: Spread;
  promptTokens: Spread;
  latencyMs: Spread;
  /** Runs that failed outright, excluded from every figure above. */
  failures: number;
}

export interface ScoredRun {
  outcome: RunOutcome;
  match: MatchResult;
  counts: CountSet;
  rates: Rates;
  crossModuleRecall: number | null;
}

export function summarise(arm: Arm, runs: ScoredRun[], failures: number): ArmSummary {
  const crossModule = runs
    .map((run) => run.crossModuleRecall)
    .filter((value): value is number => value !== null);

  return {
    arm,
    precision: spread(runs.map((run) => run.rates.precision)),
    recall: spread(runs.map((run) => run.rates.recall)),
    f1: spread(runs.map((run) => run.rates.f1)),
    crossModuleRecall: spread(crossModule),
    promptTokens: spread(runs.map((run) => run.outcome.promptTokens)),
    latencyMs: spread(runs.map((run) => run.outcome.latencyMs)),
    failures,
  };
}

/**
 * Whether the difference between two arms is worth reporting as a difference.
 *
 * Not a significance test — with a handful of runs over a handful of cases there is not
 * enough data for one, and dressing the result up as though there were would be worse than
 * saying so. This is a deliberately blunt rule: the gap has to exceed the combined spread
 * of the two arms before the scorecard is allowed to call it an improvement.
 */
export function separated(a: Spread, b: Spread): boolean {
  return Math.abs(a.mean - b.mean) > a.stdev + b.stdev;
}
