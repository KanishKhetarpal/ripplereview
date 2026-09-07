import { describe, expect, it } from 'vitest';
import { ChangeImpact } from '../core/types/change-impact';
import { ReviewResult } from '../core/types/review-result';
import { StoredRunSummary } from '../db/run-store.service';
import { renderBlastRadiusSvg } from './blast-radius-svg';
import { renderPersistenceOff, renderRunDetail, renderRunList } from './dashboard-page';
import { escapeHtml } from './escape-html';

const XSS = '<img src=x onerror="alert(1)">';

function impact(): ChangeImpact {
  return {
    repo: { root: '/repo', baseRef: 'main', headRef: 'feature' },
    changedFiles: ['src/pricing/price.service.ts'],
    changedSymbols: [
      {
        id: 'src/pricing/price.service.ts#PriceService.total',
        name: 'PriceService.total',
        kind: 'method',
        file: 'src/pricing/price.service.ts',
        line: 6,
        changeKind: 'modified',
        exported: true,
      },
    ],
    impactedSites: [
      {
        symbolId: 'src/checkout/checkout.service.ts#CheckoutService.confirm',
        file: 'src/checkout/checkout.service.ts',
        line: 5,
        hops: 1,
        viaSymbolId: 'src/pricing/price.service.ts#PriceService.total',
        moduleFanIn: 3,
      },
      {
        symbolId: 'src/api/order.controller.ts#OrderController.create',
        file: 'src/api/order.controller.ts',
        line: 4,
        hops: 2,
        viaSymbolId: 'src/pricing/price.service.ts#PriceService.total',
        moduleFanIn: 1,
      },
    ],
    cycles: [],
    layerViolations: [],
    instabilityDeltas: [],
    duplicates: [
      {
        unitId: 'src/billing/invoice.ts#reduceByBand@6',
        name: 'reduceByBand',
        file: 'src/billing/invoice.ts',
        line: 6,
        duplicateOf: { name: 'applyTieredDiscount', file: 'src/pricing/discount.ts', line: 6 },
        similarity: 1,
        scope: 'repository',
      },
    ],
    unanalysedFiles: [],
    stats: {
      hopLimit: 3,
      warmUpMs: 10,
      lookupMs: 5,
      lookups: 2,
      moduleCount: 6,
      edgeCount: 5,
      impactedSiteCount: 2,
      durationMs: 40,
    },
  };
}

function result(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    runId: '11111111-1111-4111-8111-111111111111',
    createdAt: '2026-09-07T10:00:00.000Z',
    repo: { root: '/repo', baseRef: 'main', headRef: 'feature' },
    graphGrounded: true,
    findings: [
      {
        severity: 'high',
        category: 'cross-module-regression',
        file: 'src/checkout/checkout.service.ts',
        line: 5,
        summary: 'confirm() still passes one argument',
        rationale: 'The new discount parameter defaults to 0 for every checkout.',
        evidenceRefs: ['E1'],
      },
    ],
    rejected: [],
    evidence: [
      {
        id: 'E1',
        kind: 'blast-radius',
        summary: 'CheckoutService.confirm depends on the changed total',
        weight: 800,
      },
    ],
    impact: impact(),
    llm: {
      provider: 'echo',
      model: 'echo-1',
      usage: [{ inputTokens: 100, outputTokens: 20, estimatedCostUsd: null }],
      latencyMs: 5,
      attempts: 1,
    },
    totalDurationMs: 900,
    ...overrides,
  };
}

describe('escapeHtml', () => {
  it('neutralises markup', () => {
    expect(escapeHtml(XSS)).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  });

  it('escapes quotes as well as angle brackets', () => {
    // A helper that is only correct in element text is a trap for whoever writes the next
    // attribute: `title="<value>"` would break out of the attribute with a bare quote.
    expect(escapeHtml(`a" onload='x'`)).toBe('a&quot; onload=&#39;x&#39;');
  });

  it('escapes ampersands first, so an escape is not double-encoded into nonsense', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});

describe('renderRunDetail', () => {
  it('shows the findings and the evidence they cite', () => {
    const html = renderRunDetail(result());

    expect(html).toContain('confirm() still passes one argument');
    expect(html).toContain('cross-module-regression');
    expect(html).toContain('cites E1');
    expect(html).toContain('CheckoutService.confirm depends on the changed total');
  });

  it('escapes model-written text rather than rendering it as markup', () => {
    // The summary and rationale of a finding are written by a language model, and the refs
    // come out of whatever repository was reviewed — on a public pull request that is
    // attacker-controlled. Rendering them raw is a stored XSS hole reachable by opening a
    // pull request against a watched repository.
    const html = renderRunDetail(
      result({
        findings: [
          {
            severity: 'high',
            category: 'correctness',
            file: XSS,
            line: 1,
            summary: XSS,
            rationale: XSS,
            evidenceRefs: [XSS],
          },
        ],
      }),
    );

    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('onerror="alert(1)"');
    expect(html).toContain('&lt;img src=x');
  });

  it('escapes a hostile branch name in the heading', () => {
    const html = renderRunDetail(
      result({ repo: { root: '/repo', baseRef: 'main', headRef: XSS } }),
    );

    expect(html).not.toContain('<img src=x');
  });

  it('says a diff-only run has no blast radius rather than drawing an empty one', () => {
    const html = renderRunDetail(result({ impact: null, graphGrounded: false }));

    expect(html).toContain('the graph engine was never invoked');
    expect(html).not.toContain('<svg');
  });

  it('lists duplicate logic with its similarity', () => {
    const html = renderRunDetail(result());

    expect(html).toContain('Duplicate logic (1)');
    expect(html).toContain('reduceByBand');
    expect(html).toContain('applyTieredDiscount');
    expect(html).toContain('1.00');
  });

  it('shows what the grounding guard dropped', () => {
    // A guard whose rejections are invisible cannot be told from one that never fires.
    const html = renderRunDetail(
      result({
        rejected: [
          {
            finding: {
              severity: 'high',
              category: 'architecture',
              file: 'src/a.ts',
              line: 1,
              summary: 'invented a layering breach',
              rationale: 'because',
              evidenceRefs: [],
            },
            reason: 'uncited-structural-claim',
            detail: 'category "architecture" requires at least one evidence citation',
          },
        ],
      }),
    );

    expect(html).toContain('Dropped as ungrounded (1)');
    expect(html).toContain('uncited-structural-claim');
  });
});

describe('renderRunList', () => {
  const summary: StoredRunSummary = {
    runId: '11111111-1111-4111-8111-111111111111',
    createdAt: '2026-09-07T10:00:00.000Z',
    repoRoot: '/repo',
    baseRef: 'main',
    headRef: 'feature',
    graphGrounded: true,
    provider: 'echo',
    model: 'echo-1',
    findingsCount: 2,
    rejectedCount: 1,
    promptTokens: 100,
    completionTokens: 20,
    totalDurationMs: 900,
  };

  it('links each run to its own page', () => {
    const html = renderRunList([summary]);

    expect(html).toContain(`href="runs/${summary.runId}"`);
    expect(html).toContain('1 stored run,');
  });

  it('says so plainly when there are no runs', () => {
    expect(renderRunList([])).toContain('No runs recorded yet.');
  });

  it('distinguishes an empty history from storage being switched off', () => {
    // Two very different states that a bare empty table would render identically, sending
    // the reader to look for a missing run instead of at their configuration.
    expect(renderPersistenceOff()).toContain('No runs are being stored');
    expect(renderRunList([])).not.toContain('No runs are being stored');
  });
});

describe('renderBlastRadiusSvg', () => {
  it('places each site in the column for its hop distance', () => {
    const svg = renderBlastRadiusSvg(impact());

    expect(svg).toContain('Changed');
    expect(svg).toContain('1 hop away');
    expect(svg).toContain('2 hops away');
    expect(svg).toContain('PriceService.total');
  });

  it('draws one edge per site, dashed past the first hop', () => {
    const svg = renderBlastRadiusSvg(impact());

    expect(svg.match(/class="edge hop-\d"/g)).toHaveLength(2);
    // The class the stylesheet dashes. A two-hop arrow drawn like a one-hop arrow reads as
    // a direct call, which the data does not support.
    expect(svg).toContain('class="edge hop-2"');
  });

  it('caps a column and states what it did not draw', () => {
    const large = impact();
    large.impactedSites = Array.from({ length: 25 }, (_, i) => ({
      symbolId: `src/m${i}.ts#fn${i}`,
      file: `src/m${i}.ts`,
      line: i + 1,
      hops: 1,
      viaSymbolId: 'src/pricing/price.service.ts#PriceService.total',
      moduleFanIn: i,
    }));

    const svg = renderBlastRadiusSvg(large, { maxPerColumn: 4 });

    expect(svg).toContain('+ 21 more not drawn');
    expect(svg.match(/class="edge hop-\d"/g)).toHaveLength(4);
  });

  it('escapes symbol names and paths', () => {
    const hostile = impact();
    hostile.changedSymbols[0].name = XSS;

    expect(renderBlastRadiusSvg(hostile)).not.toContain('<img src=x');
  });

  it('lays out without overlapping boxes or spilling outside the canvas', () => {
    // The one class of defect a string assertion cannot see. SVG has no layout engine:
    // every coordinate is computed here, so two boxes on top of each other, or a column
    // drawn past the edge of the viewBox, is silent — the markup is perfectly valid and
    // the picture is unreadable. Checking the geometry is both cheaper and stricter than
    // looking at it.
    const large = impact();
    large.impactedSites = Array.from({ length: 9 }, (_, i) => ({
      symbolId: `src/m${i}.ts#fn${i}`,
      file: `src/m${i}.ts`,
      line: i + 1,
      hops: (i % 3) + 1,
      viaSymbolId: 'src/pricing/price.service.ts#PriceService.total',
      moduleFanIn: i,
    }));

    const svg = renderBlastRadiusSvg(large);

    const viewBox = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
    expect(viewBox).toBeTruthy();
    const [width, height] = [Number(viewBox![1]), Number(viewBox![2])];

    const boxes = [...svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"/g)].map(
      (match) => ({
        x: Number(match[1]),
        y: Number(match[2]),
        w: Number(match[3]),
        h: Number(match[4]),
      }),
    );
    expect(boxes.length).toBe(10);

    for (const box of boxes) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.w).toBeLessThanOrEqual(width);
      expect(box.y + box.h).toBeLessThanOrEqual(height);
    }

    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const overlapping =
          a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlapping).toBe(false);
      }
    }
  });

  it('anchors every edge to a box that was actually drawn', () => {
    // An edge to a node that was capped out of its column is a line into empty space.
    const svg = renderBlastRadiusSvg(impact());

    const boxes = [...svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"/g)].map(
      (match) => ({
        left: Number(match[1]),
        right: Number(match[1]) + Number(match[3]),
        middle: Number(match[2]) + Number(match[4]) / 2,
      }),
    );

    const edges = [...svg.matchAll(/d="M ([\d.]+) ([\d.]+) C [^"]+ ([\d.]+) ([\d.]+)"/g)];
    expect(edges.length).toBeGreaterThan(0);

    for (const edge of edges) {
      const start = { x: Number(edge[1]), y: Number(edge[2]) };
      const end = { x: Number(edge[3]), y: Number(edge[4]) };
      expect(boxes.some((box) => box.right === start.x && box.middle === start.y)).toBe(true);
      expect(boxes.some((box) => box.left === end.x && box.middle === end.y)).toBe(true);
    }
  });

  it('says why it is empty instead of drawing an empty grid', () => {
    const nothing = impact();
    nothing.changedSymbols = [];
    nothing.impactedSites = [];

    expect(renderBlastRadiusSvg(nothing)).toContain('No changed symbols were resolved');
  });
});
