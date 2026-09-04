import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from '../ingest/diff-parser';
import { ChangedFile } from '../ingest/interfaces/change-set.interface';
import { Finding } from '../core/types/finding';
import { ReviewResult } from '../core/types/review-result';
import { ReviewCommentBuilder, commentableLines } from './review-comment-builder';

const builder = new ReviewCommentBuilder();

const DIFF = `diff --git a/src/pricing.ts b/src/pricing.ts
--- a/src/pricing.ts
+++ b/src/pricing.ts
@@ -8,6 +8,7 @@ export class PriceService {
   constructor() {}

   total(items: Item[]): number {
-    return items.reduce((s, i) => s + i.price, 0);
+    const gross = items.reduce((s, i) => s + i.price, 0);
+    return gross;
   }
`;

const changedFiles: ChangedFile[] = parseUnifiedDiff(DIFF);

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    severity: 'high',
    category: 'correctness',
    file: 'src/pricing.ts',
    line: 11,
    summary: 'gross is computed then returned unchanged',
    rationale: 'the extracted variable adds nothing',
    evidenceRefs: [],
    ...overrides,
  };
}

function result(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    runId: 'run-1',
    createdAt: new Date().toISOString(),
    repo: { root: '/repo', baseRef: 'main', headRef: 'feature' },
    graphGrounded: true,
    findings: [],
    rejected: [],
    evidence: [],
    impact: null,
    llm: {
      provider: 'openai',
      model: 'gpt-4o-mini',
      usage: [{ inputTokens: 100, outputTokens: 10, estimatedCostUsd: null }],
      latencyMs: 500,
      attempts: 1,
    },
    totalDurationMs: 1200,
    ...overrides,
  };
}

describe('commentableLines', () => {
  it('reports the new-side lines the diff actually changed', () => {
    const lines = commentableLines(changedFiles);
    expect([...(lines.get('src/pricing.ts') ?? [])].sort((a, b) => a - b)).toEqual([11, 12]);
  });

  it('offers no lines on a deleted file, where a comment cannot land', () => {
    const deleted: ChangedFile[] = [{ path: 'src/gone.ts', status: 'deleted', hunks: [] }];
    expect(commentableLines(deleted).has('src/gone.ts')).toBe(false);
  });
});

describe('ReviewCommentBuilder', () => {
  it('places a finding on a changed line inline', () => {
    const review = builder.build(result({ findings: [finding({ line: 11 })] }), changedFiles);

    expect(review.inline).toHaveLength(1);
    expect(review.inline[0]).toMatchObject({ path: 'src/pricing.ts', line: 11, side: 'RIGHT' });
    expect(review.offDiffCount).toBe(0);
  });

  it('puts a finding on an UNCHANGED line of a changed file into the summary', () => {
    // GitHub rejects an inline comment on a line the diff does not touch, and one
    // rejection fails the entire review request — taking every placeable comment with it.
    const review = builder.build(result({ findings: [finding({ line: 40 })] }), changedFiles);

    expect(review.inline).toHaveLength(0);
    expect(review.offDiffCount).toBe(1);
    expect(review.summary).toContain('outside the diff');
  });

  it('puts a blast-radius finding in the summary, since its file is not in the diff at all', () => {
    // This is the product's own point colliding with GitHub's constraint: the findings
    // that justify this tool are about files the diff never mentions, so they can never
    // be inline.
    const review = builder.build(
      result({ findings: [finding({ file: 'src/invoicing/invoice.builder.ts', line: 9 })] }),
      changedFiles,
    );

    expect(review.inline).toHaveLength(0);
    expect(review.summary).toContain('src/invoicing/invoice.builder.ts');
    expect(review.summary).toContain('code this change *reaches*');
  });

  it('never emits an inline comment on a line outside the diff', () => {
    const findings = [
      finding({ line: 11 }),
      finding({ line: 12 }),
      finding({ line: 999 }),
      finding({ file: 'src/elsewhere.ts', line: 1 }),
      finding({ line: 0 }),
    ];
    const review = builder.build(result({ findings }), changedFiles);
    const commentable = commentableLines(changedFiles);

    for (const comment of review.inline) {
      expect(commentable.get(comment.path)?.has(comment.line)).toBe(true);
    }
    expect(review.inline.length + review.offDiffCount).toBe(findings.length);
  });

  it('treats a whole-change finding (line 0) as not placeable', () => {
    const review = builder.build(result({ findings: [finding({ line: 0 })] }), changedFiles);
    expect(review.inline).toHaveLength(0);
  });

  it('orders inline comments by severity', () => {
    const review = builder.build(
      result({
        findings: [
          finding({ line: 12, severity: 'low' }),
          finding({ line: 11, severity: 'critical' }),
        ],
      }),
      changedFiles,
    );
    expect(review.inline[0].line).toBe(11);
  });

  it('normalises a Windows-style path, which would otherwise never match', () => {
    const review = builder.build(
      result({ findings: [finding({ file: 'src\\pricing.ts', line: 11 })] }),
      changedFiles,
    );
    expect(review.inline[0].path).toBe('src/pricing.ts');
  });

  it('carries the severity, category, rationale and citations into the comment body', () => {
    const review = builder.build(
      result({ findings: [finding({ line: 11, evidenceRefs: ['E3'] })] }),
      changedFiles,
    );
    const body = review.inline[0].body;
    expect(body).toContain('high');
    expect(body).toContain('correctness');
    expect(body).toContain('the extracted variable adds nothing');
    expect(body).toContain('E3');
  });

  describe('summary', () => {
    it('reports the blast radius when there is one', () => {
      const review = builder.build(
        result({
          impact: {
            repo: { root: '/repo', baseRef: 'main', headRef: 'feature' },
            changedFiles: ['src/pricing.ts'],
            changedSymbols: [
              {
                id: 'src/pricing.ts#total',
                name: 'total',
                kind: 'method',
                file: 'src/pricing.ts',
                line: 10,
                changeKind: 'modified',
                exported: true,
              },
            ],
            impactedSites: [],
            cycles: [{ nodeIds: ['a.ts', 'b.ts'], introducedByChange: true }],
            layerViolations: [
              {
                rule: 'deny src/domain/** -> src/infra/**',
                fromModule: 'src/domain/o.ts',
                toModule: 'src/infra/db.ts',
                specifier: '../infra/db',
                introducedByChange: true,
              },
            ],
            instabilityDeltas: [],
            unanalysedFiles: [],
            stats: {
              hopLimit: 3,
              warmUpMs: 0,
              lookupMs: 0,
              lookups: 1,
              moduleCount: 9,
              edgeCount: 11,
              impactedSiteCount: 0,
              durationMs: 100,
            },
          },
        }),
        changedFiles,
      );

      expect(review.summary).toContain('Blast radius');
      expect(review.summary).toContain('Introduces a dependency cycle');
      expect(review.summary).toContain('Breaks an architecture rule');
      expect(review.summary).toContain('deny src/domain/** -> src/infra/**');
    });

    it('says so when the run was diff-only', () => {
      const review = builder.build(result({ graphGrounded: false }), changedFiles);
      expect(review.summary).toContain('diff-only');
    });

    it('says nothing about diff-only for a grounded run', () => {
      expect(builder.build(result(), changedFiles).summary).not.toContain('Ran **diff-only**');
    });

    it('discloses findings the grounding guard dropped', () => {
      // A guard whose rejections are invisible cannot be told from one that never fires.
      const review = builder.build(
        result({
          rejected: [
            {
              finding: finding(),
              reason: 'uncited-structural-claim',
              detail: 'no citation',
            },
          ],
        }),
        changedFiles,
      );
      expect(review.summary).toContain('dropped as ungrounded');
    });

    it('reports no findings plainly', () => {
      expect(builder.build(result(), changedFiles).summary).toContain('No findings.');
    });

    it('escapes a pipe in evidence text, which would otherwise break the table', () => {
      const review = builder.build(
        result({
          evidence: [{ id: 'E1', kind: 'cycle', summary: 'a.ts | b.ts', weight: 1 }],
        }),
        changedFiles,
      );
      expect(review.summary).toContain('a.ts \\| b.ts');
    });

    it('records the model and run id for traceability', () => {
      const review = builder.build(result(), changedFiles);
      expect(review.summary).toContain('openai/gpt-4o-mini');
      expect(review.summary).toContain('run-1');
    });
  });
});
