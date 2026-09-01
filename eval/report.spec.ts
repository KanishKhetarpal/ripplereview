import { describe, expect, it } from 'vitest';
import { spread } from './metrics';
import { toMarkdown, toSvg } from './report';
import { ArmSummary } from './metrics';
import { EvalReport } from './runner';

function armSummary(arm: 'grounded' | 'diff-only', values: number[]): ArmSummary {
  return {
    arm,
    precision: spread(values),
    recall: spread(values),
    f1: spread(values),
    crossModuleRecall: spread(values),
    promptTokens: spread([6500]),
    latencyMs: spread([1200]),
    failures: 0,
  };
}

const report = (provider: string): EvalReport => ({
    startedAt: '2026-09-02T10:00:00.000Z',
    finishedAt: '2026-09-02T10:05:00.000Z',
    provider,
    model: 'test-model',
    runsPerArm: 3,
    cases: [
      {
        case: 'signature-drift',
        summary: 'a caller two modules away is never updated',
        defectCount: 1,
        arms: {
          grounded: armSummary('grounded', [1, 1, 1]),
          'diff-only': armSummary('diff-only', [0, 0, 0]),
        },
        runs: [
          {
            outcome: {
              case: 'signature-drift',
              arm: 'diff-only',
              run: 1,
              findings: [],
              promptTokens: 5000,
              completionTokens: 100,
              latencyMs: 900,
            },
            match: { caught: [], missed: ['invoice-ignores-discount'], falsePositives: [], duplicates: [] },
            counts: { truePositives: 0, falsePositives: 0, falseNegatives: 1, duplicates: 0 },
            rates: { precision: 1, recall: 0, f1: 0 },
            crossModuleRecall: 0,
          },
        ],
      },
    ],
  overall: {
    grounded: armSummary('grounded', [1, 1, 1]),
    'diff-only': armSummary('diff-only', [0, 0, 0]),
  },
});

describe('toMarkdown', () => {
  it('leads with the verdict', () => {
    expect(toMarkdown(report('openai')).split('\n')[2]).toContain('MORE cross-module defects');
  });

  it('names the provider, model and run count, so a number can be reproduced', () => {
    const markdown = toMarkdown(report('openai'));
    expect(markdown).toContain('`openai`');
    expect(markdown).toContain('`test-model`');
    expect(markdown).toContain('3 run(s) per arm');
  });

  it('SHOUTS when the run used the offline stub rather than a model', () => {
    // Without this a stub scorecard is indistinguishable at a glance from a real one, and
    // "0% vs 0%, no measurable difference" reads as a genuine negative result.
    const markdown = toMarkdown(report('echo'));
    expect(markdown).toContain('used the `echo` stub, not a language model');
    expect(markdown).toContain('meaningless as a measure of review quality');
  });

  it('carries no stub warning for a real provider', () => {
    expect(toMarkdown(report('openai'))).not.toContain('echo` stub');
  });

  it('reports the spread beside every mean', () => {
    expect(toMarkdown(report('openai'))).toContain('population standard deviation');
  });

  it('explains how a finding is credited, so the number can be argued with', () => {
    const markdown = toMarkdown(report('openai'));
    expect(markdown).toContain('How a finding is credited');
    expect(markdown).toContain('No language model is involved in scoring');
  });

  it('names defects that both arms missed in every run', () => {
    expect(toMarkdown(report('openai'))).toContain('invoice-ignores-discount');
  });

  it('reports failed runs, so a scorecard built from failures cannot look clean', () => {
    expect(toMarkdown(report('openai'))).toContain('Failed runs');
  });
});

describe('toSvg', () => {
  it('renders both bars', () => {
    const svg = toSvg(report('openai'));
    expect(svg).toContain('Graph-grounded');
    expect(svg).toContain('Diff-only');
    expect(svg).toContain('<svg');
  });

  it('scales the bars to the values', () => {
    const svg = toSvg(report('openai'));
    expect(svg).toContain('100.0%');
    expect(svg).toContain('0.0%');
  });

  it('escapes provider text rather than injecting it raw into markup', () => {
    const svg = toSvg({ ...report('openai'), provider: 'a<b&c' });
    expect(svg).toContain('a&lt;b&amp;c');
    expect(svg).not.toContain('a<b&c');
  });
});
