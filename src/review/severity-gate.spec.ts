import { describe, expect, it } from 'vitest';
import { Finding, Severity } from '../core/types/finding';
import { blockingFindings, shouldFail } from './severity-gate';

const at = (severity: Severity): Finding => ({
  severity,
  category: 'correctness',
  file: 'src/a.ts',
  line: 1,
  summary: 's',
  rationale: 'r',
  evidenceRefs: [],
});

describe('shouldFail', () => {
  it('fails on a finding at the threshold', () => {
    expect(shouldFail([at('high')], 'high')).toBe(true);
  });

  it('fails on a finding ABOVE the threshold', () => {
    // SEVERITY_ORDER puts critical at 0, so "at or above" is a <= on the rank. That reads
    // backwards, and getting it wrong would let critical findings through a `high` gate.
    expect(shouldFail([at('critical')], 'high')).toBe(true);
  });

  it('does not fail on a finding below the threshold', () => {
    expect(shouldFail([at('medium')], 'high')).toBe(false);
  });

  it('never fails when the threshold is "never"', () => {
    expect(shouldFail([at('critical')], 'never')).toBe(false);
  });

  it('fails on anything at all when the threshold is info', () => {
    expect(shouldFail([at('info')], 'info')).toBe(true);
  });

  it('does not fail on an empty review', () => {
    expect(shouldFail([], 'info')).toBe(false);
  });

  it('fails when any one finding qualifies, not only the first', () => {
    expect(shouldFail([at('low'), at('info'), at('critical')], 'high')).toBe(true);
  });
});

describe('blockingFindings', () => {
  it('returns only the findings that tripped the gate', () => {
    const blocking = blockingFindings([at('low'), at('critical'), at('high')], 'high');
    expect(blocking.map((f) => f.severity).sort()).toEqual(['critical', 'high']);
  });

  it('returns nothing when the threshold is "never"', () => {
    expect(blockingFindings([at('critical')], 'never')).toEqual([]);
  });
});
