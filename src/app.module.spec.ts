import { INestApplicationContext } from '@nestjs/common';
import { rmSync } from 'node:fs';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from './app.module';
import { HealthController } from './health/health.controller';
import { LlmService } from './llm/llm.service';
import { ReportRenderer } from './output/report-renderer';
import { ReviewService } from './review/review.service';
import { buildFixtureRepo } from './graph/__fixtures__/build-fixture-repo';

const ESC = String.fromCharCode(27);

/**
 * Boots the real container. This is the test that would catch a missing provider, a
 * circular module import, or `emitDecoratorMetadata` silently not being emitted by the
 * test transform — none of which a unit test with hand-built instances can see.
 */
describe('AppModule (real container)', () => {
  let app: INestApplicationContext;

  beforeAll(async () => {
    process.env.LLM_PROVIDER = 'echo';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    moduleRef.useLogger(false);
    app = await moduleRef.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('resolves the echo provider by default', () => {
    expect(app.get(LlmService).providerName).toBe('echo');
  });

  it('reports honestly which stages exist', () => {
    const report = app.get(HealthController).check();
    expect(report.status).toBe('ok');
    expect(report.stages.graph).toBe('implemented');
    expect(report.stages.contextAssembler).toBe('implemented');
    expect(report.stages.persistence).toBe('not-implemented');
    expect(report.stages.githubWebhook).toBe('implemented');
    // The webhook verifies and acknowledges; nothing dispatches a review yet, and one
    // combined github stage would report a working integration that stops half way.
    expect(report.stages.githubReviewDispatch).toBe('not-implemented');
    expect(report.stages.llmAdapter).toBe('implemented');
  });

  it('reviews a real repository end to end, grounded in the graph', async () => {
    const fixture = buildFixtureRepo();
    try {
      const result = await app.get(ReviewService).run({
        repoPath: fixture.path,
        baseRef: 'HEAD~1',
        headRef: 'HEAD',
      });

      expect(result.graphGrounded).toBe(true);
      // The evidence the model saw came from the graph, not from the diff.
      expect(result.evidence.length).toBeGreaterThan(0);
      expect(result.evidence.some((item) => item.kind === 'cycle')).toBe(true);
      expect(result.impact?.changedSymbols.map((s) => s.id)).toContain(
        'src/pricing/price.service.ts#PriceService.total',
      );
    } finally {
      rmSync(fixture.path, { recursive: true, force: true });
    }
  }, 120_000);

  it('runs the diff-only baseline with the same pipeline and no evidence', async () => {
    const fixture = buildFixtureRepo();
    try {
      const result = await app.get(ReviewService).run({
        repoPath: fixture.path,
        baseRef: 'HEAD~1',
        headRef: 'HEAD',
        diffOnly: true,
      });

      expect(result.graphGrounded).toBe(false);
      expect(result.evidence).toEqual([]);
      // The graph engine is not run at all, so there is no impact to report — a baseline
      // that paid for the analysis it claims not to use would flatter the comparison.
      expect(result.impact).toBeNull();
    } finally {
      rmSync(fixture.path, { recursive: true, force: true });
    }
  }, 120_000);

  it('runs the demo end to end and grounds every finding it keeps', async () => {
    const result = await app.get(ReviewService).runDemo();

    expect(result.llm.provider).toBe('echo');
    expect(result.findings.length + result.rejected.length).toBeGreaterThan(0);

    const known = new Set(result.evidence.map((item) => item.id));
    for (const finding of result.findings) {
      for (const ref of finding.evidenceRefs) {
        expect(known.has(ref)).toBe(true);
      }
    }
  });

  it('renders the demo result as text and as JSON', async () => {
    const result = await app.get(ReviewService).runDemo();
    const renderer = app.get(ReportRenderer);

    const text = renderer.renderText(result, { color: false });
    expect(text).toContain('RippleReview');
    expect(text).toContain('Blast radius');
    expect(text).toContain('1 circular dependency introduced');

    const json: unknown = JSON.parse(renderer.renderJson(result));
    expect(json).toHaveProperty('runId');
  });

  it('emits no ANSI escapes when colour is off', async () => {
    const result = await app.get(ReviewService).runDemo();
    const text = app.get(ReportRenderer).renderText(result, { color: false });
    expect(text.includes(ESC)).toBe(false);
  });

  it('emits ANSI escapes when colour is on', async () => {
    const result = await app.get(ReviewService).runDemo();
    const text = app.get(ReportRenderer).renderText(result, { color: true });
    expect(text.includes(ESC)).toBe(true);
  });
});
