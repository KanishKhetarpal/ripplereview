import { describe, expect, it } from 'vitest';
import { Category, Finding } from '../src/core/types/finding';
import { WHOLE_CHANGE_TOLERANCE, identifies, matchFindings } from './matcher';
import { KnownDefect } from './types';

const defect = (overrides: Partial<KnownDefect> = {}): KnownDefect => ({
  id: 'd1',
  kind: 'cross-module',
  file: 'src/invoicing/invoice.builder.ts',
  line: 9,
  lineTolerance: 6,
  acceptCategories: ['cross-module-regression', 'correctness'],
  description: 'the planted defect',
  ...overrides,
});

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  severity: 'high',
  category: 'cross-module-regression',
  file: 'src/invoicing/invoice.builder.ts',
  line: 9,
  summary: 'invoice still passes one argument',
  rationale: 'because',
  evidenceRefs: ['E1'],
  ...overrides,
});

describe('identifies', () => {
  it('credits a finding on the right file, line and category', () => {
    expect(identifies(finding(), defect())).toBe(true);
  });

  it('credits a finding inside the line tolerance', () => {
    expect(identifies(finding({ line: 14 }), defect())).toBe(true);
    expect(identifies(finding({ line: 4 }), defect())).toBe(true);
  });

  it('refuses a finding outside the line tolerance', () => {
    // Without this, any finding anywhere in a small file scores, which is close to giving
    // a point for naming the file.
    expect(identifies(finding({ line: 40 }), defect())).toBe(false);
  });

  it('refuses a finding in a different file', () => {
    expect(identifies(finding({ file: 'src/pricing/price.service.ts' }), defect())).toBe(false);
  });

  it('refuses the right line for the wrong reason', () => {
    // A maintainability nit at the site of a silent regression is not a catch. This rule
    // is what stops a reviewer scoring well by emitting one vague finding per file.
    expect(identifies(finding({ category: 'maintainability' }), defect())).toBe(false);
  });

  it('accepts any of the defect\'s listed categories', () => {
    expect(identifies(finding({ category: 'correctness' }), defect())).toBe(true);
  });

  it('normalises path separators, so a Windows-style path still matches', () => {
    expect(identifies(finding({ file: 'src\\invoicing\\invoice.builder.ts' }), defect())).toBe(
      true,
    );
  });

  it('normalises a leading ./', () => {
    expect(identifies(finding({ file: './src/invoicing/invoice.builder.ts' }), defect())).toBe(
      true,
    );
  });

  describe('whole-change findings (line 0)', () => {
    const cycle = defect({
      id: 'cycle',
      kind: 'cycle',
      file: 'src/session/session.store.ts',
      line: 1,
      lineTolerance: WHOLE_CHANGE_TOLERANCE,
      acceptCategories: ['circular-dependency'],
    });

    it('credits line 0 for a defect that is not line-specific', () => {
      // "This change closes an import cycle" is a property of the change, not of a line.
      const wholeChange = finding({
        line: 0,
        category: 'circular-dependency',
        file: 'src/session/session.store.ts',
      });
      expect(identifies(wholeChange, cycle)).toBe(true);
    });

    it('refuses line 0 for a defect that IS line-specific', () => {
      // Otherwise a reviewer could score every line-specific defect by declining to say
      // where it is.
      expect(identifies(finding({ line: 0 }), defect())).toBe(false);
    });

    it('still requires the right file for a whole-change finding', () => {
      const elsewhere = finding({ line: 0, category: 'circular-dependency', file: 'src/x.ts' });
      expect(identifies(elsewhere, cycle)).toBe(false);
    });
  });
});

describe('matchFindings', () => {
  it('reports a caught defect', () => {
    const result = matchFindings([finding()], [defect()]);
    expect(result.caught).toEqual(['d1']);
    expect(result.missed).toEqual([]);
    expect(result.falsePositives).toEqual([]);
  });

  it('reports a missed defect', () => {
    const result = matchFindings([], [defect()]);
    expect(result.caught).toEqual([]);
    expect(result.missed).toEqual(['d1']);
  });

  it('reports a finding that matches nothing as a false positive', () => {
    const spurious = finding({ file: 'src/unrelated.ts' });
    const result = matchFindings([spurious], [defect()]);
    expect(result.falsePositives).toEqual([spurious]);
  });

  it('credits a defect once when several findings identify it', () => {
    const result = matchFindings([finding(), finding({ line: 10 })], [defect()]);
    expect(result.caught).toEqual(['d1']);
    expect(result.duplicates).toHaveLength(1);
  });

  it('counts the duplicate as neither a hit nor a false positive', () => {
    // Calling it wrong punishes thoroughness; crediting it twice lets one repeated finding
    // inflate recall.
    const result = matchFindings([finding(), finding()], [defect()]);
    expect(result.caught).toHaveLength(1);
    expect(result.falsePositives).toHaveLength(0);
    expect(result.duplicates).toHaveLength(1);
  });

  it('handles several defects independently', () => {
    const second = defect({ id: 'd2', file: 'src/other.ts', line: 3 });
    const result = matchFindings(
      [finding(), finding({ file: 'src/other.ts', line: 3 })],
      [defect(), second],
    );
    expect(result.caught.sort()).toEqual(['d1', 'd2']);
  });

  it('reports everything as a false positive when there are no defects', () => {
    // The clean-refactor case: every finding is invented by construction.
    const result = matchFindings([finding()], []);
    expect(result.falsePositives).toHaveLength(1);
    expect(result.missed).toEqual([]);
  });

  it('reports nothing at all for no findings and no defects', () => {
    const result = matchFindings([], []);
    expect(result).toEqual({ caught: [], missed: [], falsePositives: [], duplicates: [] });
  });

  it('never loses a finding: every one is a hit, a duplicate or a false positive', () => {
    const findings = [
      finding(),
      finding(),
      finding({ file: 'src/unrelated.ts' }),
      finding({ category: 'security' as Category }),
    ];
    const result = matchFindings(findings, [defect()]);
    const accounted =
      result.caught.length + result.duplicates.length + result.falsePositives.length;
    expect(accounted).toBe(findings.length);
  });
});
