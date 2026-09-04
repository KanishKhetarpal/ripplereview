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
    expect(response.body.stages.persistence).toBe('not-implemented');
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

  it('answers 503 for run lookup when persistence is off, not 404', async () => {
    // 404 would tell the caller the run does not exist. It may well exist; there is
    // simply nowhere to look, and those lead to completely different actions.
    const response = await request(server()).get('/api/v1/review/runs/abc').expect(503);
    expect(JSON.stringify(response.body)).toContain('DATABASE_URL');
  });

  it('answers 503 for the run listing too', async () => {
    await request(server()).get('/api/v1/review/runs').expect(503);
  });
});
