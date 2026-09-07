import { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module';
import { DomainErrorFilter } from '../common/domain-error.filter';

const HAS_DB = Boolean(process.env.DATABASE_URL);

/**
 * The dashboard over real HTTP.
 *
 * What is asserted here belongs to the wiring rather than to the templates: that the route
 * is mounted where it is documented, that it declares itself as HTML, and that a bad id is
 * a bad request rather than a 500 out of the database driver.
 */
describe('Dashboard HTTP', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.LLM_PROVIDER = 'echo';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    moduleRef.useLogger(false);
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new DomainErrorFilter());
    await app.init();
  }, 60_000);

  const server = (): Server => app.getHttpServer() as Server;

  afterAll(async () => {
    await app?.close();
  });

  it('serves the run list as HTML at the documented path', async () => {
    const response = await request(server()).get('/api/v1/dashboard').expect(200);

    expect(response.headers['content-type']).toContain('text/html');
    expect(response.text).toContain('<!doctype html>');
    expect(response.text).toContain('RippleReview');
  });

  it('carries its own styles, with nothing fetched from a third party', async () => {
    // A dashboard that renders nothing without reaching someone else's CDN fails exactly
    // when it is most wanted: offline, or inside a network with no outbound access.
    const response = await request(server()).get('/api/v1/dashboard').expect(200);

    expect(response.text).toContain('<style>');
    expect(response.text).not.toMatch(/<script|<link[^>]+href="http/i);
  });

  it('rejects a malformed run id as a bad request, not a server error', async () => {
    // Postgres raises `invalid input syntax for type uuid` for anything else, which is
    // unmapped and would surface as a bare 500 for a plainly bad URL.
    await request(server()).get('/api/v1/dashboard/runs/not-a-uuid').expect(400);
  });

  it.skipIf(!HAS_DB)('answers 404 for a well-formed id naming no run', async () => {
    await request(server())
      .get('/api/v1/dashboard/runs/11111111-1111-4111-8111-111111111111')
      .expect(404);
  });

  it.skipIf(HAS_DB)('explains that storage is off rather than erroring', async () => {
    // The API answers 503 here, because a client must be able to tell "off" from "empty".
    // A person looking at a browser needs a sentence instead.
    const response = await request(server())
      .get('/api/v1/dashboard/runs/11111111-1111-4111-8111-111111111111')
      .expect(200);

    expect(response.text).toContain('No runs are being stored');
  });
});
