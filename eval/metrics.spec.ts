import { describe, expect, it } from 'vitest';
import { Finding } from '../src/core/types/finding';
import { countsFor, crossModuleRecall, ratesFor, separated, spread } from './metrics';
import { verdict } from './report';
import { EvalReport } from './runner';
import { KnownDefect, MatchResult } from './types';

const finding = (): Finding => ({
  severity: 'high',
  category: 'correctness',
  file: 'src/a.ts',
  line: 1,
  summary: 's',
  rationale: 'r',
  evidenceRefs: [],
});

const match = (overrides: Partial<MatchResult> = {}): MatchResult => ({
  caught: [],
  missed: [],
  falsePositives: [],
  duplicates: [],
  ...overrides,
});

describe('countsFor', () => {
  it('counts hits, misses, false positives and duplicates separately', () => {
    const counts = countsFor(
      match({
        caught: ['a', 'b'],
        missed: ['c'],
        falsePositives: [finding()],
        duplicates: [finding(), finding()],
      }),
    );
    expect(counts).toEqual({
      truePositives: 2,
      falsePositives: 1,
      falseNegatives: 1,
      duplicates: 2,
    });
  });
});

describe('ratesFor', () => {
  it('computes precision, recall and F1', () => {
    const rates = ratesFor({
      truePositives: 3,
      falsePositives: 1,
      falseNegatives: 1,
      duplicates: 0,
    });
    expect(rates.precision).toBeCloseTo(0.75);
    expect(rates.recall).toBeCloseTo(0.75);
    expect(rates.f1).toBeCloseTo(0.75);
  });

  it('treats a silent reviewer as perfectly precise and useless', () => {
    // Precision 1 is the convention — nothing wrong was said — but recall is 0, and F1
    // reports the combination as worthless, which is the honest summary.
    const rates = ratesFor({
      truePositives: 0,
      falsePositives: 0,
      falseNegatives: 2,
      duplicates: 0,
    });
    expect(rates.precision).toBe(1);
    expect(rates.recall).toBe(0);
    expect(rates.f1).toBe(0);
  });

  it('gives full recall when there was nothing to find', () => {
    // The clean-refactor case. Everything there was to find was found.
    const rates = ratesFor({
      truePositives: 0,
      falsePositives: 0,
      falseNegatives: 0,
      duplicates: 0,
    });
    expect(rates.recall).toBe(1);
    expect(rates.precision).toBe(1);
  });

  it('drops precision when a silent-case reviewer invents findings', () => {
    const rates = ratesFor({
      truePositives: 0,
      falsePositives: 3,
      falseNegatives: 0,
      duplicates: 0,
    });
    expect(rates.precision).toBe(0);
    expect(rates.recall).toBe(1);
  });

  it('never produces NaN, which would poison every mean downstream', () => {
    const rates = ratesFor({
      truePositives: 0,
      falsePositives: 0,
      falseNegatives: 0,
      duplicates: 0,
    });
    expect(Number.isNaN(rates.f1)).toBe(false);
  });
});

describe('crossModuleRecall', () => {
  const defects: KnownDefect[] = [
    {
      id: 'cross',
      kind: 'cross-module',
      file: 'a',
      line: 1,
      lineTolerance: 1,
      acceptCategories: [],
      description: '',
    },
    {
      id: 'local',
      kind: 'local',
      file: 'b',
      line: 1,
      lineTolerance: 1,
      acceptCategories: [],
      description: '',
    },
  ];

  it('ignores local defects, which both arms can see', () => {
    // Mixing them in dilutes exactly the difference the project claims to create.
    expect(crossModuleRecall(match({ caught: ['cross'], missed: ['local'] }), defects)).toBe(1);
  });

  it('reports zero when the structural defect was missed but the local one was caught', () => {
    expect(crossModuleRecall(match({ caught: ['local'], missed: ['cross'] }), defects)).toBe(0);
  });

  it('answers null when a case has no structural defect to measure', () => {
    // Null rather than 0 or 1: the case has nothing to say about the headline claim, and
    // folding it in as either would move the average for no reason.
    expect(crossModuleRecall(match(), [defects[1]])).toBeNull();
  });
});

describe('spread', () => {
  it('reports mean, deviation and range', () => {
    const result = spread([0.2, 0.4, 0.6]);
    expect(result.mean).toBeCloseTo(0.4);
    expect(result.min).toBe(0.2);
    expect(result.max).toBe(0.6);
    expect(result.n).toBe(3);
    expect(result.stdev).toBeCloseTo(0.1633, 3);
  });

  it('reports zero deviation for identical runs', () => {
    expect(spread([0.5, 0.5, 0.5]).stdev).toBe(0);
  });

  it('handles a single run without producing NaN', () => {
    expect(spread([0.7])).toEqual({ mean: 0.7, stdev: 0, min: 0.7, max: 0.7, n: 1 });
  });

  it('handles no runs at all', () => {
    expect(spread([]).n).toBe(0);
  });
});

describe('separated', () => {
  it('calls a gap wider than the combined spread a real difference', () => {
    expect(separated(spread([0.9, 0.9, 0.9]), spread([0.2, 0.2, 0.2]))).toBe(true);
  });

  it('refuses to call a gap smaller than the noise a difference', () => {
    // Two arms whose means differ by less than their own run-to-run variation are not a
    // result, and reporting them as one is how an eval confirms whatever it was built to.
    expect(separated(spread([0.5, 0.9, 0.1]), spread([0.4, 0.8, 0.0]))).toBe(false);
  });

  it('refuses an identical pair', () => {
    expect(separated(spread([0.5]), spread([0.5]))).toBe(false);
  });
});

describe('verdict', () => {
  const report = (grounded: number[], baseline: number[]): EvalReport => ({
      startedAt: '',
      finishedAt: '',
      provider: 'test',
      model: 'test',
      runsPerArm: grounded.length,
      cases: [],
      overall: {
        grounded: {
          arm: 'grounded',
          precision: spread([]),
          recall: spread([]),
          f1: spread([]),
          crossModuleRecall: spread(grounded),
          promptTokens: spread([]),
          latencyMs: spread([]),
          failures: 0,
        },
        'diff-only': {
          arm: 'diff-only',
          precision: spread([]),
          recall: spread([]),
          f1: spread([]),
          crossModuleRecall: spread(baseline),
          promptTokens: spread([]),
          latencyMs: spread([]),
          failures: 0,
        },
    },
  });

  it('reports a real win as a win', () => {
    // The harness must be ABLE to say the thesis held, or "no difference" is the only
    // sentence it can ever produce and the whole measurement is decorative.
    const sentence = verdict(report([1, 1, 1], [0, 0, 0]));
    expect(sentence).toContain('MORE cross-module defects');
    expect(sentence).toContain('100.0%');
  });

  it('reports a real loss as a loss', () => {
    const sentence = verdict(report([0, 0, 0], [1, 1, 1]));
    expect(sentence).toContain('FEWER cross-module defects');
    expect(sentence).toContain('not supported');
  });

  it('refuses to call a noisy gap a result', () => {
    const sentence = verdict(report([1, 0, 1, 0], [0, 1, 0, 0]));
    expect(sentence).toContain('NO MEASURABLE DIFFERENCE');
  });

  it('says so when there is nothing to compare', () => {
    expect(verdict(report([], []))).toContain('INCONCLUSIVE');
  });
});
