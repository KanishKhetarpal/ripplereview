import { describe, expect, it } from 'vitest';
import { enforceGrounding } from './grounding';
import { EvidenceItem } from './types/evidence';
import { Finding } from './types/finding';

const evidence: EvidenceItem[] = [
  { id: 'E1', kind: 'blast-radius', summary: 'a calls b', weight: 10 },
  { id: 'E2', kind: 'cycle', summary: 'a <-> b', weight: 20 },
];

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    severity: 'high',
    category: 'correctness',
    file: 'src/a.ts',
    line: 10,
    summary: 'something',
    rationale: 'because',
    evidenceRefs: [],
    ...overrides,
  };
}

describe('enforceGrounding', () => {
  it('keeps a structural finding that cites known evidence', () => {
    const result = enforceGrounding(
      [finding({ category: 'cross-module-regression', evidenceRefs: ['E1'] })],
      evidence,
    );
    expect(result.kept).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  it('drops a structural finding that cites nothing', () => {
    const result = enforceGrounding(
      [finding({ category: 'circular-dependency', evidenceRefs: [] })],
      evidence,
    );
    expect(result.kept).toHaveLength(0);
    expect(result.rejected[0].reason).toBe('uncited-structural-claim');
  });

  it('drops any finding citing evidence that was never supplied', () => {
    const result = enforceGrounding(
      [finding({ category: 'correctness', evidenceRefs: ['E9'] })],
      evidence,
    );
    expect(result.kept).toHaveLength(0);
    expect(result.rejected[0].reason).toBe('unknown-evidence-ref');
    expect(result.rejected[0].detail).toContain('E9');
  });

  it('reports every unknown id it saw, not just the first', () => {
    const result = enforceGrounding([finding({ evidenceRefs: ['E1', 'E7', 'E8'] })], evidence);
    expect(result.rejected[0].detail).toContain('E7');
    expect(result.rejected[0].detail).toContain('E8');
  });

  it('lets a non-structural finding stand uncited', () => {
    const result = enforceGrounding([finding({ category: 'maintainability' })], evidence);
    expect(result.kept).toHaveLength(1);
  });

  it('checks unknown ids before the citation requirement, so the reason is specific', () => {
    const result = enforceGrounding(
      [finding({ category: 'architecture', evidenceRefs: ['E404'] })],
      evidence,
    );
    expect(result.rejected[0].reason).toBe('unknown-evidence-ref');
  });

  it('rejects everything when the evidence set is empty and claims are structural', () => {
    const result = enforceGrounding(
      [finding({ category: 'architecture', evidenceRefs: ['E1'] })],
      [],
    );
    expect(result.kept).toHaveLength(0);
  });

  it('partitions a mixed batch without losing any finding', () => {
    const batch = [
      finding({ category: 'correctness' }),
      finding({ category: 'architecture', evidenceRefs: [] }),
      finding({ category: 'cross-module-regression', evidenceRefs: ['E2'] }),
    ];
    const result = enforceGrounding(batch, evidence);
    expect(result.kept.length + result.rejected.length).toBe(batch.length);
    expect(result.kept).toHaveLength(2);
  });
});
