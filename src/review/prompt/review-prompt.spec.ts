import { describe, expect, it } from 'vitest';
import { ContextAssemblerService } from '../../context/context-assembler.service';
import { EvidenceBuilder } from '../../context/evidence-builder';
import { BpeTokenCounter } from '../../context/token-counter';
import { TypeExtractor } from '../../context/type-extractor';
import { ChangeImpact } from '../../core/types/change-impact';
import { STRUCTURAL_CATEGORIES } from '../../core/types/finding';
import { parseFindings } from '../../llm/parsing/finding-parser';
import { buildSystemPrompt, buildUserPrompt } from './review-prompt';

const assembler = new ContextAssemblerService(
  new EvidenceBuilder(),
  new TypeExtractor(),
  new BpeTokenCounter(),
);

/**
 * A change with one of everything: an introduced cycle, an introduced layering violation,
 * callers at two hop distances, and an instability shift.
 */
const IMPACT: ChangeImpact = {
  repo: { root: '/repo', baseRef: 'main', headRef: 'feature/discounts' },
  changedFiles: ['src/pricing/price.service.ts', 'src/domain/order.ts'],
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
  impactedSites: [
    {
      symbolId: 'src/checkout/checkout.service.ts#CheckoutService.confirm',
      file: 'src/checkout/checkout.service.ts',
      line: 88,
      hops: 1,
      viaSymbolId: 'src/pricing/price.service.ts#PriceService.total',
      moduleFanIn: 6,
    },
    {
      symbolId: 'src/api/order.controller.ts#OrderController.create',
      file: 'src/api/order.controller.ts',
      line: 31,
      hops: 2,
      viaSymbolId: 'src/pricing/price.service.ts#PriceService.total',
      moduleFanIn: 2,
    },
  ],
  cycles: [
    {
      nodeIds: ['src/checkout/checkout.service.ts', 'src/pricing/price.service.ts'],
      introducedByChange: true,
    },
  ],
  layerViolations: [
    {
      rule: 'deny src/domain/** -> src/infra/**',
      fromModule: 'src/domain/order.ts',
      toModule: 'src/infra/db.ts',
      specifier: '../infra/db',
      introducedByChange: true,
    },
  ],
  instabilityDeltas: [
    {
      module: 'src/domain/order.ts',
      before: { fanIn: 1, fanOut: 0, instability: 0 },
      after: { fanIn: 1, fanOut: 1, instability: 0.5 },
    },
  ],
  unanalysedFiles: [],
  stats: {
    hopLimit: 3,
    warmUpMs: 120,
    lookupMs: 40,
    lookups: 3,
    moduleCount: 9,
    edgeCount: 11,
    impactedSiteCount: 2,
    durationMs: 250,
  },
};

const DIFF = `diff --git a/src/pricing/price.service.ts b/src/pricing/price.service.ts
--- a/src/pricing/price.service.ts
+++ b/src/pricing/price.service.ts
@@ -40,4 +40,5 @@ export class PriceService {
-  total(items: Item[]): number {
-    return items.reduce((sum, item) => sum + item.price, 0);
+  total(items: Item[], discount = 0): number {
+    const gross = items.reduce((sum, item) => sum + item.price, 0);
+    return gross - discount;
   }
`;

const context = assembler.assemble(IMPACT, DIFF, {
  maxTokens: 60_000,
  reserveForResponse: 4096,
  systemPromptTokens: 500,
  repoRoot: '/repo',
});

describe('system prompt', () => {
  const system = buildSystemPrompt();
  /** The prompt is wrapped for readability, so a phrase may straddle a line break. */
  const flat = system.replace(/\s+/g, ' ');

  it('states the grounding contract in the imperative', () => {
    expect(flat).toContain('MUST cite the evidence ids');
    expect(flat).toContain('NEVER assert a call site, dependency, cycle or import');
  });

  it('tells the model the evidence may be incomplete but is never wrong', () => {
    // Without this it treats an absent site as proof of absence, and reports "no callers
    // are affected" from a blast radius that was truncated for budget.
    expect(flat).toContain('may be incomplete; it is never wrong');
  });

  it('demands reasoning rather than restatement', () => {
    expect(flat).toContain('Restating an evidence line is not a finding');
  });

  it('permits an uncited local observation, so small real bugs are not suppressed', () => {
    expect(flat).toContain('needs no citation');
  });

  it('names every severity the schema accepts', () => {
    for (const severity of ['critical', 'high', 'medium', 'low', 'info']) {
      expect(system).toContain(severity);
    }
  });

  it('names every category the schema accepts, so the model cannot invent one', () => {
    // A category outside the enum fails validation and burns a repair round.
    for (const category of STRUCTURAL_CATEGORIES) {
      expect(system).toContain(category);
    }
  });

  it('rules out style findings, which a linter already covers', () => {
    expect(flat).toContain('Do not report style, formatting or import ordering');
  });

  it('says an empty findings array is acceptable', () => {
    expect(flat).toContain('empty findings array is a valid and useful answer');
  });

  it('embeds a schema hint that the real parser accepts', () => {
    // If the hint and the schema ever disagree, the model is being told to produce
    // something that will be rejected.
    const match = system.match(/\{"findings":.*\}/s);
    expect(match).not.toBeNull();
    const example = JSON.parse(match![0]) as { findings: Record<string, unknown>[] };
    const concrete = {
      findings: [
        {
          ...example.findings[0],
          severity: 'high',
          category: 'correctness',
          line: 1,
          confidence: 0.5,
        },
      ],
    };
    expect(parseFindings(JSON.stringify(concrete)).ok).toBe(true);
  });
});

describe('user prompt', () => {
  const user = buildUserPrompt(context);

  it('carries the diff', () => {
    expect(user).toContain('total(items: Item[], discount = 0)');
  });

  it('puts the diff before the evidence, since the evidence is about the diff', () => {
    expect(user.indexOf('## DIFF UNDER REVIEW')).toBeLessThan(user.indexOf('## EVIDENCE'));
  });

  it('renders every evidence item with a citable id', () => {
    for (const item of context.evidence) {
      expect(user).toContain(`[${item.id}]`);
    }
  });

  it('leads with the introduced cycle', () => {
    expect(user).toContain('[E1] (cycle)');
    expect(user).toContain('INTRODUCES a circular dependency');
  });

  it('names the architecture rule verbatim, so the finding is recognisable', () => {
    expect(user).toContain('deny src/domain/** -> src/infra/**');
  });

  it('states hop distance and fan-in for each impacted site', () => {
    expect(user).toContain('1 hop away, module fan-in 6');
    expect(user).toContain('2 hops away, module fan-in 2');
  });

  it('names the refs under review', () => {
    expect(user).toContain('main');
    expect(user).toContain('feature/discounts');
  });

  it('warns when evidence was dropped, so absence is not read as proof', () => {
    const truncated = { ...context, budget: { ...context.budget, droppedItemIds: ['E9'] } };
    expect(buildUserPrompt(truncated)).toContain('lower bound');
  });

  it('says nothing about dropped evidence when nothing was dropped', () => {
    expect(user).not.toContain('lower bound');
  });
});

describe('user prompt for the diff-only baseline', () => {
  const baseline = assembler.assembleDiffOnly(DIFF, 'main', 'feature/discounts', {
    maxTokens: 60_000,
    reserveForResponse: 4096,
    systemPromptTokens: 500,
    repoRoot: '/repo',
  });
  const user = buildUserPrompt(baseline);

  it('carries the same diff as the grounded arm', () => {
    expect(user).toContain('total(items: Item[], discount = 0)');
  });

  it('carries no evidence ids', () => {
    expect(user).not.toMatch(/\[E\d+\]/);
  });

  it('says the analysis was not run, rather than implying nothing is affected', () => {
    // An empty evidence block otherwise reads as "the graph found nothing", which would
    // make the baseline claim more than it knows and flatter it in the comparison.
    expect(user).toContain('Do not infer from this that the change is self-contained');
    expect(user).toContain('make no structural claims');
  });
});

describe('golden context', () => {
  /**
   * Pins the exact assembled prompt for a fixed change.
   *
   * The assembler is the differentiator and it has no natural failure signal: a ranking bug
   * or a dropped evidence kind still produces a perfectly plausible prompt, and every test
   * above would still pass. This one fails the moment the output changes at all — which is
   * the point. Re-approve it deliberately, by reading the diff.
   */
  it('matches the approved snapshot', () => {
    expect(buildUserPrompt(context)).toMatchInlineSnapshot(`
      "## DIFF UNDER REVIEW
      Base: main   Head: feature/discounts

      diff --git a/src/pricing/price.service.ts b/src/pricing/price.service.ts
      --- a/src/pricing/price.service.ts
      +++ b/src/pricing/price.service.ts
      @@ -40,4 +40,5 @@ export class PriceService {
      -  total(items: Item[]): number {
      -    return items.reduce((sum, item) => sum + item.price, 0);
      +  total(items: Item[], discount = 0): number {
      +    const gross = items.reduce((sum, item) => sum + item.price, 0);
      +    return gross - discount;
         }

      ## EVIDENCE (5 facts, ranked most important first)
      Computed from the dependency graph. Cite these ids for every structural claim.

      [E1] (cycle) src/checkout/checkout.service.ts This change INTRODUCES a circular dependency: src/checkout/checkout.service.ts -> src/pricing/price.service.ts -> src/checkout/checkout.service.ts
      [E2] (layer-violation) src/domain/order.ts This change INTRODUCES architecture violation: src/domain/order.ts imports src/infra/db.ts, forbidden by "deny src/domain/** -> src/infra/**"
      [E3] (blast-radius) src/checkout/checkout.service.ts:88 CheckoutService.confirm at src/checkout/checkout.service.ts:88 depends on the changed PriceService.total (1 hop away, module fan-in 6)
      [E4] (blast-radius) src/api/order.controller.ts:31 OrderController.create at src/api/order.controller.ts:31 depends on the changed PriceService.total (2 hops away, module fan-in 2)
      [E5] (instability) src/domain/order.ts src/domain/order.ts instability 0.00 -> 0.50 (fan-in 1, fan-out 1)"
    `);
  });
});
