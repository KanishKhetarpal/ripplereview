import { INestApplicationContext, NotImplementedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from './app.module';
import { HealthController } from './health/health.controller';
import { LlmService } from './llm/llm.service';
import { ReportRenderer } from './output/report-renderer';
import { ReviewService } from './review/review.service';

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
    expect(report.stages.contextAssembler).toBe('not-implemented');
    expect(report.stages.llmAdapter).toBe('implemented');
  });

  it('refuses a real repository review rather than faking one', async () => {
    const reviews = app.get(ReviewService);
    await expect(
      Promise.resolve().then(() =>
        reviews.run({ repoPath: '.', baseRef: 'main', headRef: 'HEAD' }),
      ),
    ).rejects.toBeInstanceOf(NotImplementedException);
  });

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
