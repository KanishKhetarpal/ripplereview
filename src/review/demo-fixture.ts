import { ChangeImpact } from '../core/types/change-impact';
import { EvidenceItem, ReviewContext } from '../core/types/evidence';

/**
 * A hand-written change, used by `ripplereview demo` and `POST /review/demo`.
 *
 * It exists so the half of the pipeline that is real in Phase 0 — provider call, schema
 * validation, repair, grounding, rendering — can be run end to end before the graph engine
 * exists. It is a fixture and is labelled as one everywhere it surfaces; it is never a
 * substitute for analysing a repository.
 */
export const DEMO_IMPACT: ChangeImpact = {
  repo: { root: '/demo/shop', baseRef: 'main', headRef: 'feature/discounts' },
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
      symbolId: 'src/reporting/revenue.report.ts#buildRevenueRow',
      file: 'src/reporting/revenue.report.ts',
      line: 31,
      hops: 2,
      viaSymbolId: 'src/pricing/price.service.ts#PriceService.total',
      moduleFanIn: 2,
    },
  ],
  cycles: [
    {
      nodeIds: ['src/pricing/price.service.ts', 'src/checkout/checkout.service.ts'],
      introducedByChange: true,
    },
  ],
  layerViolations: [],
  instabilityDeltas: [],
  stats: {
    hopLimit: 3,
    moduleCount: 24,
    edgeCount: 57,
    impactedSiteCount: 2,
    durationMs: 0,
  },
};

export const DEMO_EVIDENCE: EvidenceItem[] = [
  {
    id: 'E1',
    kind: 'blast-radius',
    summary: 'CheckoutService.confirm calls PriceService.total (1 hop, module fan-in 6)',
    location: { file: 'src/checkout/checkout.service.ts', line: 88 },
    weight: 100,
  },
  {
    id: 'E2',
    kind: 'blast-radius',
    summary: 'buildRevenueRow reaches PriceService.total (2 hops, module fan-in 2)',
    location: { file: 'src/reporting/revenue.report.ts', line: 31 },
    weight: 60,
  },
  {
    id: 'E3',
    kind: 'cycle',
    summary:
      'New cycle introduced: src/pricing/price.service.ts <-> src/checkout/checkout.service.ts',
    weight: 120,
  },
];

export const DEMO_DIFF = `--- a/src/pricing/price.service.ts
+++ b/src/pricing/price.service.ts
@@ -39,7 +39,9 @@ export class PriceService {
-  total(items: Item[]): number {
-    return items.reduce((sum, item) => sum + item.price, 0);
+  total(items: Item[], discount = 0): number {
+    const gross = items.reduce((sum, item) => sum + item.price, 0);
+    return gross - discount;
   }
`;

export function buildDemoContext(tokenBudget: number): ReviewContext {
  return {
    diff: DEMO_DIFF,
    evidence: DEMO_EVIDENCE,
    budget: { maxTokens: tokenBudget, usedTokens: 0, droppedItemIds: [] },
    meta: {
      repoRoot: DEMO_IMPACT.repo.root,
      baseRef: DEMO_IMPACT.repo.baseRef,
      headRef: DEMO_IMPACT.repo.headRef,
      graphGrounded: true,
    },
  };
}
