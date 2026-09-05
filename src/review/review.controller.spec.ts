import { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import { Test } from '@nestjs/testing';
import { rmSync } from 'node:fs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module';
import { DomainErrorFilter } from '../common/domain-error.filter';
import { buildFixtureRepo } from '../graph/__fixtures__/build-fixture-repo';

/**
 * Hits the real HTTP surface. Status codes, the JSON envelope and body validation are the
 * API's contract with a GitHub Action; calling the service directly proves none of it.
 */
describe('Review HTTP API', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.LLM_PROVIDER = 'echo';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    moduleRef.useLogger(false);
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new DomainErrorFilter());
    await app.init();
  });

  // getHttpServer() is typed `any`; narrow it once here rather than at six call sites.
  const server = (): Server => app.getHttpServer() as Server;

  afterAll(async () => {
    await app?.close();
  });

  it('serves a health report naming the implemented stages', async () => {
    const response = await request(server()).get('/api/v1/health').expect(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.stages.contextAssembler).toBe('implemented');
    expect(response.body.stages.persistence).toBe(
      process.env.DATABASE_URL ? 'implemented' : 'not-implemented',
    );
    expect(response.body.stages.githubWebhook).toBe('implemented');
  });

  it('runs the demo review over HTTP', async () => {
    const response = await request(server()).post('/api/v1/review/demo').expect(201);
    expect(response.body.graphGrounded).toBe(true);
    expect(response.body.llm.provider).toBe('echo');
    expect(Array.isArray(response.body.findings)).toBe(true);
  });

  it('reviews a real repository over HTTP', async () => {
    const fixture = buildFixtureRepo();
    try {
      const response = await request(server())
        .post('/api/v1/review')
        .send({ repoPath: fixture.path, baseRef: 'HEAD~1', headRef: 'HEAD' })
        .expect(201);

      expect(response.body.graphGrounded).toBe(true);
      expect(response.body.evidence.length).toBeGreaterThan(0);
    } finally {
      rmSync(fixture.path, { recursive: true, force: true });
    }
  }, 120_000);

  it('reports a repository that does not exist as a client error, not a 500', async () => {
    const response = await request(server())
      .post('/api/v1/review')
      .send({ repoPath: '/no/such/repository', baseRef: 'HEAD~1', headRef: 'HEAD' });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(response.body)).toMatch(/not a git repository|does not exist/i);
  }, 60_000);

  it('rejects a body with no repoPath as 400, naming the field', async () => {
    const response = await request(server())
      .post('/api/v1/review')
      .send({ baseRef: 'main' })
      .expect(400);
    expect(JSON.stringify(response.body)).toContain('repoPath');
  });

  it('rejects a wrong-typed field as 400', async () => {
    await request(server())
      .post('/api/v1/review')
      .send({ repoPath: '.', diffOnly: 'yes please' })
      .expect(400);
  });

  it('rejects a malformed run id as 400, whether or not a database is configured', async () => {
    // With persistence on, an unvalidated id reaches Postgres and raises
    // `invalid input syntax for type uuid`, which surfaced as a bare 500.
    await request(server()).get('/api/v1/review/runs/abc').expect(400);
  });

  describe.skipIf(Boolean(process.env.DATABASE_URL))('with persistence off', () => {
    it('answers 503 for a run lookup, not 404', async () => {
      // 404 would tell the caller the run does not exist. It may well exist; there is
      // simply nowhere to look, and those lead to completely different actions.
      const response = await request(server())
        .get('/api/v1/review/runs/11111111-1111-4111-8111-111111111111')
        .expect(503);
      expect(JSON.stringify(response.body)).toContain('DATABASE_URL');
    });

    it('answers 503 for the run listing too', async () => {
      await request(server()).get('/api/v1/review/runs').expect(503);
    });
  });

  describe.skipIf(!process.env.DATABASE_URL)('with persistence on', () => {
    it('answers 404 for a well-formed id that names no run', async () => {
      await request(server())
        .get('/api/v1/review/runs/11111111-1111-4111-8111-111111111111')
        .expect(404);
    });

    it('lists runs', async () => {
      const response = await request(server()).get('/api/v1/review/runs').expect(200);
      expect(Array.isArray(response.body)).toBe(true);
    });

    it('stores a review and reads it back by its run id', async () => {
      // The full round trip the API exists for, exercised only where a database is
      // actually present.
      const fixture = buildFixtureRepo();
      try {
        const posted = await request(server())
          .post('/api/v1/review')
          .send({ repoPath: fixture.path, baseRef: 'HEAD~1', headRef: 'HEAD' })
          .expect(201);

        const stored = await request(server())
          .get(`/api/v1/review/runs/${posted.body.runId}`)
          .expect(200);

        expect(stored.body.runId).toBe(posted.body.runId);
        expect(stored.body.graphGrounded).toBe(true);
        expect(stored.body.impact.changedSymbols.length).toBeGreaterThan(0);
      } finally {
        rmSync(fixture.path, { recursive: true, force: true });
      }
    }, 120_000);
  });
});
