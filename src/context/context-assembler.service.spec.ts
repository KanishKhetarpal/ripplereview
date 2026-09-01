import { describe, expect, it } from 'vitest';
import { ChangeImpact, ImpactedSite } from '../core/types/change-impact';
import {
  BudgetTooSmallError,
  ContextAssemblerService,
  SAFETY_MARGIN_TOKENS,
  renderEvidence,
  splitDiffByFile,
} from './context-assembler.service';
import { EvidenceBuilder } from './evidence-builder';
import { BpeTokenCounter } from './token-counter';
import { TypeExtractor } from './type-extractor';

const counter = new BpeTokenCounter();
const assembler = new ContextAssemblerService(new EvidenceBuilder(), new TypeExtractor(), counter);

function impactWith(overrides: Partial<ChangeImpact> = {}): ChangeImpact {
  return {
    repo: { root: '/repo', baseRef: 'main', headRef: 'feature' },
    changedFiles: ['src/pricing/price.service.ts'],
    changedSymbols: [
      {
        id: 'src/pricing/price.service.ts#PriceService.total',
        name: 'PriceService.total',
        kind: 'method',
        file: 'src/pricing/price.service.ts',
        line: 42,
        changeKind: 'modified',
        exported: true,
      },
    ],
    impactedSites: [],
    cycles: [],
    layerViolations: [],
    instabilityDeltas: [],
    unanalysedFiles: [],
    stats: {
      hopLimit: 3,
      warmUpMs: 0,
      lookupMs: 0,
      lookups: 1,
      moduleCount: 10,
      edgeCount: 12,
      impactedSiteCount: 0,
      durationMs: 5,
    },
    ...overrides,
  };
}

const site = (file: string, hops: number, fanIn: number): ImpactedSite => ({
  symbolId: `${file}#fn`,
  file,
  line: 10,
  hops,
  viaSymbolId: 'src/pricing/price.service.ts#PriceService.total',
  moduleFanIn: fanIn,
});

const DIFF = `diff --git a/src/pricing/price.service.ts b/src/pricing/price.service.ts
--- a/src/pricing/price.service.ts
+++ b/src/pricing/price.service.ts
@@ -40,3 +40,4 @@
-  total(items: Item[]): number {
+  total(items: Item[], discount = 0): number {
`;

const baseOptions = {
  maxTokens: 60_000,
  reserveForResponse: 4096,
  systemPromptTokens: 500,
  repoRoot: '/repo',
};

describe('ContextAssemblerService.assemble', () => {
  it('always includes the diff', () => {
    const context = assembler.assemble(impactWith(), DIFF, baseOptions);
    expect(context.diff).toContain('discount = 0');
    expect(context.truncatedDiff).toBe(false);
  });

  it('reserves the response and the safety margin out of the budget', () => {
    const context = assembler.assemble(impactWith(), DIFF, baseOptions);
    expect(context.budget.maxTokens).toBe(60_000 - 4096 - 500 - SAFETY_MARGIN_TOKENS);
  });

  it('refuses a budget that leaves no room, instead of assembling an empty prompt', () => {
    expect(() =>
      assembler.assemble(impactWith(), DIFF, { ...baseOptions, maxTokens: 1000 }),
    ).toThrow(BudgetTooSmallError);
  });

  it('numbers evidence in rank order, so E1 is the most important fact', () => {
    const context = assembler.assemble(
      impactWith({
        impactedSites: [site('src/far.ts', 3, 1)],
        cycles: [{ nodeIds: ['a.ts', 'b.ts'], introducedByChange: true }],
      }),
      DIFF,
      baseOptions,
    );

    expect(context.evidence[0].id).toBe('E1');
    expect(context.evidence[0].kind).toBe('cycle');
    expect(context.evidence[0].summary).toContain('INTRODUCES');
  });

  it('ranks an introduced cycle above every impacted site', () => {
    const context = assembler.assemble(
      impactWith({
        impactedSites: [site('src/near.ts', 1, 50)],
        cycles: [{ nodeIds: ['a.ts', 'b.ts'], introducedByChange: true }],
      }),
      DIFF,
      baseOptions,
    );

    expect(context.evidence[0].kind).toBe('cycle');
    expect(context.evidence[1].kind).toBe('blast-radius');
  });

  it('ranks a nearer call site above a further one', () => {
    const context = assembler.assemble(
      impactWith({ impactedSites: [site('src/far.ts', 3, 90), site('src/near.ts', 1, 1)] }),
      DIFF,
      baseOptions,
    );

    expect(context.evidence[0].location?.file).toBe('src/near.ts');
  });

  it('breaks a hop-distance tie by module fan-in', () => {
    const context = assembler.assemble(
      impactWith({ impactedSites: [site('src/quiet.ts', 2, 1), site('src/hub.ts', 2, 40)] }),
      DIFF,
      baseOptions,
    );

    expect(context.evidence[0].location?.file).toBe('src/hub.ts');
  });

  it('ranks a pre-existing cycle below a direct caller', () => {
    const context = assembler.assemble(
      impactWith({
        impactedSites: [site('src/near.ts', 1, 5)],
        cycles: [{ nodeIds: ['a.ts', 'b.ts'], introducedByChange: false }],
      }),
      DIFF,
      baseOptions,
    );

    expect(context.evidence[0].kind).toBe('blast-radius');
  });

  it('records what did not fit, rather than dropping it silently', () => {
    const manySites = Array.from({ length: 400 }, (_, i) => site(`src/mod${i}.ts`, 1, i));
    const context = assembler.assemble(impactWith({ impactedSites: manySites }), DIFF, {
      ...baseOptions,
      maxTokens: 6000,
    });

    expect(context.budget.droppedItemIds.length).toBeGreaterThan(0);
    expect(context.evidence.length + context.budget.droppedItemIds.length).toBe(400);
  });

  it('keeps the packed total inside the budget', () => {
    const manySites = Array.from({ length: 400 }, (_, i) => site(`src/mod${i}.ts`, 1, i));
    const context = assembler.assemble(impactWith({ impactedSites: manySites }), DIFF, {
      ...baseOptions,
      maxTokens: 6000,
    });

    expect(context.budget.usedTokens).toBeLessThanOrEqual(context.budget.maxTokens);
  });

  it('drops the lowest-ranked items, not an arbitrary subset', () => {
    const manySites = Array.from({ length: 400 }, (_, i) => site(`src/mod${i}.ts`, 1, i));
    const context = assembler.assemble(impactWith({ impactedSites: manySites }), DIFF, {
      ...baseOptions,
      maxTokens: 6000,
    });

    const keptIds = context.evidence.map((item) => Number(item.id.slice(1)));
    const droppedIds = context.budget.droppedItemIds.map((id) => Number(id.slice(1)));
    expect(Math.max(...keptIds)).toBeLessThan(Math.min(...droppedIds));
  });

  it('marks the context as graph-grounded', () => {
    const context = assembler.assemble(impactWith(), DIFF, baseOptions);
    expect(context.meta.graphGrounded).toBe(true);
  });
});

describe('diff truncation', () => {
  const hugeDiff = Array.from(
    { length: 60 },
    (_, i) =>
      `diff --git a/src/file${i}.ts b/src/file${i}.ts\n--- a/src/file${i}.ts\n+++ b/src/file${i}.ts\n@@ -1,3 +1,3 @@\n${'+const x = 1;\n'.repeat(40)}`,
  ).join('');

  it('caps the diff at roughly 60% of the budget so evidence still fits', () => {
    const context = assembler.assemble(impactWith(), hugeDiff, {
      ...baseOptions,
      maxTokens: 12_000,
    });

    expect(context.truncatedDiff).toBe(true);
    // The fraction is written out rather than read from MAX_DIFF_SHARE. Computing the
    // expectation from the constant under test moves both sides together, so raising the
    // share to 1.0 — letting the diff eat the whole budget — passed silently.
    expect(counter.count(context.diff)).toBeLessThanOrEqual(context.budget.maxTokens * 0.65);
  });

  it('keeps enough budget for a substantial amount of evidence', () => {
    const manySites = Array.from({ length: 60 }, (_, i) => site(`src/mod${i}.ts`, 1, i));
    const context = assembler.assemble(impactWith({ impactedSites: manySites }), hugeDiff, {
      ...baseOptions,
      maxTokens: 12_000,
    });

    // Not merely "more than zero": one surviving item is what a diff consuming 98% of the
    // budget still leaves, and that is the failure this cap exists to prevent.
    expect(context.evidence.length).toBeGreaterThanOrEqual(20);
  });

  it('tells the model what was omitted instead of leaving it to infer', () => {
    const context = assembler.assemble(impactWith(), hugeDiff, {
      ...baseOptions,
      maxTokens: 12_000,
    });
    expect(context.diff).toContain('omitted from this diff');
    expect(context.diff).toContain('must not assume the omitted files are unchanged');
  });

  it('truncates by whole files, never mid-hunk', () => {
    const context = assembler.assemble(impactWith(), hugeDiff, {
      ...baseOptions,
      maxTokens: 12_000,
    });

    const chunks = splitDiffByFile(context.diff).filter((c) => c.startsWith('diff --git'));
    for (const chunk of chunks) {
      expect(chunk).toContain('@@');
      expect(chunk).toContain('+++');
    }
  });

  it('leaves room for evidence even when the diff is enormous', () => {
    const context = assembler.assemble(
      impactWith({ impactedSites: [site('src/near.ts', 1, 9)] }),
      hugeDiff,
      { ...baseOptions, maxTokens: 12_000 },
    );
    expect(context.evidence.length).toBeGreaterThan(0);
  });
});

describe('assembleDiffOnly (the eval baseline)', () => {
  it('carries the diff and no evidence at all', () => {
    const context = assembler.assembleDiffOnly(DIFF, 'main', 'feature', baseOptions);
    expect(context.diff).toContain('discount = 0');
    expect(context.evidence).toEqual([]);
  });

  it('marks itself as NOT graph-grounded, so a run cannot be mistaken for the real thing', () => {
    const context = assembler.assembleDiffOnly(DIFF, 'main', 'feature', baseOptions);
    expect(context.meta.graphGrounded).toBe(false);
  });

  it('gets the same budget as the grounded arm, so the comparison is fair', () => {
    const grounded = assembler.assemble(impactWith(), DIFF, baseOptions);
    const baseline = assembler.assembleDiffOnly(DIFF, 'main', 'feature', baseOptions);
    expect(baseline.budget.maxTokens).toBe(grounded.budget.maxTokens);
  });

  it('fits the diff exactly as the grounded arm does', () => {
    const grounded = assembler.assemble(impactWith(), DIFF, baseOptions);
    const baseline = assembler.assembleDiffOnly(DIFF, 'main', 'feature', baseOptions);
    expect(baseline.diff).toBe(grounded.diff);
  });
});

describe('renderEvidence', () => {
  it('renders one citable line', () => {
    expect(
      renderEvidence({
        id: 'E1',
        kind: 'cycle',
        summary: 'a <-> b',
        weight: 1,
      }),
    ).toBe('[E1] (cycle) a <-> b');
  });

  it('includes the location when there is one', () => {
    expect(
      renderEvidence({
        id: 'E2',
        kind: 'blast-radius',
        summary: 'x calls y',
        location: { file: 'src/a.ts', line: 12 },
        weight: 1,
      }),
    ).toBe('[E2] (blast-radius) src/a.ts:12 x calls y');
  });

  it('puts a quoted definition on its own lines', () => {
    const rendered = renderEvidence({
      id: 'E3',
      kind: 'type-definition',
      summary: 'Definition of Item',
      detail: 'interface Item {\n  price: number;\n}',
      location: { file: 'src/item.ts', line: 1 },
      weight: 1,
    });
    expect(rendered).toContain('\ninterface Item {');
  });
});

describe('splitDiffByFile', () => {
  it('splits on each file header', () => {
    const two = `${DIFF}diff --git a/src/b.ts b/src/b.ts\n@@ -1 +1 @@\n+x\n`;
    expect(splitDiffByFile(two)).toHaveLength(2);
  });

  it('keeps a single-file diff whole', () => {
    expect(splitDiffByFile(DIFF)).toHaveLength(1);
  });

  it('returns nothing meaningful for an empty diff', () => {
    expect(splitDiffByFile('').join('')).toBe('');
  });
});
