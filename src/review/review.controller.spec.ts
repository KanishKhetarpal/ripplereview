import { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module';

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
    expect(response.body.stages.contextAssembler).toBe('not-implemented');
  });

  it('runs the demo review over HTTP', async () => {
    const response = await request(server()).post('/api/v1/review/demo').expect(201);
    expect(response.body.graphGrounded).toBe(true);
    expect(response.body.llm.provider).toBe('echo');
    expect(Array.isArray(response.body.findings)).toBe(true);
  });

  it('answers 501 for a real review rather than returning an empty result', async () => {
    await request(server())
      .post('/api/v1/review')
      .send({ repoPath: '.', baseRef: 'main', headRef: 'HEAD' })
      .expect(501);
  });

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

  it('answers 501 for run lookup, since nothing is persisted yet', async () => {
    await request(server()).get('/api/v1/review/runs/abc').expect(501);
  });
});
