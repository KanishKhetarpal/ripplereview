import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EnqueueRequest, JobStoreService, MAX_ATTEMPTS } from './job-store.service';
import { MigrationRunner } from './migration-runner';
import { PersistenceDisabledError } from './run-store.service';

const DATABASE_URL = process.env.DATABASE_URL;
const HAS_DB = Boolean(DATABASE_URL);

/**
 * Runs against a real PostgreSQL, because every guarantee here belongs to the database:
 * that a unique constraint collapses a retry storm, that FOR UPDATE SKIP LOCKED lets two
 * workers claim different rows instead of the same one, that a CHECK constraint refuses a
 * bogus state. None of that is observable against a mock.
 */
if (!HAS_DB && process.env.CI === 'true') {
  throw new Error(
    'DATABASE_URL is unset under CI. The queue tests cannot run, and skipping them would ' +
      'report a pass for a job queue nothing verified.',
  );
}

function request(overrides: Partial<EnqueueRequest> = {}): EnqueueRequest {
  return {
    deliveryId: randomUUID(),
    owner: 'acme',
    repo: 'widgets',
    pullNumber: 42,
    headSha: 'a'.repeat(40),
    baseRef: 'main',
    cloneUrl: 'https://github.com/acme/widgets.git',
    ...overrides,
  };
}

describe.skipIf(!HAS_DB)('JobStoreService (real PostgreSQL)', () => {
  let pool: Pool;
  let store: JobStoreService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
    await new MigrationRunner().apply(pool);
    store = new JobStoreService(pool);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    // Each test starts from an empty queue; claimNext takes the oldest pending job
    // globally, so leftovers from a previous test would be claimed by the next one.
    await pool.query('DELETE FROM review_jobs');
  });

  it('queues a delivery', async () => {
    const req = request();
    expect(await store.enqueue(req)).toBe('queued');

    const job = await store.findByDelivery(req.deliveryId);
    expect(job?.state).toBe('pending');
    expect(job?.pullNumber).toBe(42);
    expect(job?.attempts).toBe(0);
  });

  it('collapses a retried delivery into one job', async () => {
    // GitHub reuses the delivery id when it retries a timed-out delivery. Without the
    // unique constraint, a slow first response produces a second review of the same code.
    const req = request();
    expect(await store.enqueue(req)).toBe('queued');
    expect(await store.enqueue(req)).toBe('duplicate');

    const count = await pool.query('SELECT count(*)::int AS n FROM review_jobs');
    expect((count.rows[0] as { n: number }).n).toBe(1);
  });

  it('supersedes an older PENDING job for the same pull request', async () => {
    // Pushing three times in a minute produces three deliveries. Reviewing the first two
    // spends model calls to comment on code that has already been replaced, and posts
    // contradictory reviews on one pull request.
    const first = request({ headSha: 'b'.repeat(40) });
    const second = request({ headSha: 'c'.repeat(40) });

    await store.enqueue(first);
    await store.enqueue(second);

    expect((await store.findByDelivery(first.deliveryId))?.state).toBe('superseded');
    expect((await store.findByDelivery(second.deliveryId))?.state).toBe('pending');
  });

  it('does not supersede a job for a DIFFERENT pull request', async () => {
    const a = request({ pullNumber: 1 });
    const b = request({ pullNumber: 2 });

    await store.enqueue(a);
    await store.enqueue(b);

    expect((await store.findByDelivery(a.deliveryId))?.state).toBe('pending');
    expect((await store.findByDelivery(b.deliveryId))?.state).toBe('pending');
  });

  it('does not supersede a job already RUNNING', async () => {
    // It has a checkout in flight and will finish; cancelling mid-flight leaves a temp
    // directory behind and buys nothing, since the newer job queues behind it.
    const first = request();
    await store.enqueue(first);
    await store.claimNext();

    await store.enqueue(request());

    expect((await store.findByDelivery(first.deliveryId))?.state).toBe('running');
  });

  it('claims the oldest pending job first', async () => {
    const first = request({ pullNumber: 1 });
    const second = request({ pullNumber: 2 });
    await store.enqueue(first);
    await store.enqueue(second);

    const claimed = await store.claimNext();
    expect(claimed?.deliveryId).toBe(first.deliveryId);
  });

  it('marks a claimed job running and counts the attempt', async () => {
    await store.enqueue(request());
    const claimed = await store.claimNext();

    expect(claimed?.state).toBe('running');
    // Incremented on CLAIM, not on failure, so a job that kills the worker still burns an
    // attempt instead of being retried forever.
    expect(claimed?.attempts).toBe(1);
  });

  it('answers null when the queue is empty', async () => {
    expect(await store.claimNext()).toBeNull();
  });

  it('never hands the same job to two workers', async () => {
    // FOR UPDATE SKIP LOCKED is the whole reason the queue lives in Postgres. Two
    // concurrent claims must take different rows, not the same one twice.
    await store.enqueue(request({ pullNumber: 1 }));
    await store.enqueue(request({ pullNumber: 2 }));

    const [a, b] = await Promise.all([store.claimNext(), store.claimNext()]);

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a?.id).not.toBe(b?.id);
  });

  it('hands out nothing twice even when claims outnumber jobs', async () => {
    await store.enqueue(request());

    const claims = await Promise.all([store.claimNext(), store.claimNext(), store.claimNext()]);
    const claimed = claims.filter((job) => job !== null);

    expect(claimed).toHaveLength(1);
  });

  it('marks a job done with the run it produced', async () => {
    await store.enqueue(request());
    const job = await store.claimNext();

    const runId = randomUUID();
    await pool.query(
      `INSERT INTO runs (id, created_at, repo_root, base_ref, head_ref, graph_grounded,
                         provider, model, prompt_tokens, completion_tokens, llm_latency_ms,
                         attempts, total_duration_ms, findings_count, rejected_count)
       VALUES ($1, now(), '/r', 'main', 'HEAD', true, 'echo', 'echo', 0, 0, 0, 1, 0, 0, 0)`,
      [runId],
    );
    await store.markDone(job!.id, runId);

    const stored = await store.findByDelivery(job!.deliveryId);
    expect(stored?.state).toBe('done');
    expect(stored?.runId).toBe(runId);
  });

  it('returns a failed job to the queue while it has attempts left', async () => {
    await store.enqueue(request());
    const job = await store.claimNext();

    expect(await store.markFailed(job!.id, 'clone timed out')).toBe('pending');
    expect((await store.findByDelivery(job!.deliveryId))?.lastError).toBe('clone timed out');
  });

  it('gives up after the attempt budget instead of retrying forever', async () => {
    await store.enqueue(request());

    let state = 'pending';
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const job = await store.claimNext();
      expect(job).not.toBeNull();
      state = await store.markFailed(job!.id, 'still broken');
    }

    expect(state).toBe('failed');
    expect(await store.claimNext()).toBeNull();
  });

  it('truncates a huge error rather than failing the update', async () => {
    await store.enqueue(request());
    const job = await store.claimNext();

    await expect(store.markFailed(job!.id, 'x'.repeat(50_000))).resolves.toBeTruthy();
  });

  it('requeues a job left running by a killed worker', async () => {
    // The claim is a state change, not a lease, so nothing else would ever pick it up.
    await store.enqueue(request());
    const job = await store.claimNext();
    await pool.query(
      `UPDATE review_jobs SET claimed_at = now() - interval '2 hours' WHERE id = $1`,
      [job!.id],
    );

    expect(await store.requeueStale(30)).toBe(1);
    expect((await store.findByDelivery(job!.deliveryId))?.state).toBe('pending');
  });

  it('leaves a recently claimed job alone', async () => {
    await store.enqueue(request());
    const job = await store.claimNext();

    expect(await store.requeueStale(30)).toBe(0);
    expect((await store.findByDelivery(job!.deliveryId))?.state).toBe('running');
  });

  it('counts pending work', async () => {
    await store.enqueue(request({ pullNumber: 1 }));
    await store.enqueue(request({ pullNumber: 2 }));
    expect(await store.pendingCount()).toBe(2);

    await store.claimNext();
    expect(await store.pendingCount()).toBe(1);
  });

  it('refuses a state the schema does not allow', async () => {
    // The CHECK constraint is the last line of defence against a typo in a state string
    // silently creating jobs nothing will ever claim.
    await expect(
      pool.query(
        `INSERT INTO review_jobs (delivery_id, owner, repo, pull_number, head_sha, base_ref, clone_url, state)
         VALUES ($1,'o','r',1,'sha','main','url','nonsense')`,
        [randomUUID()],
      ),
    ).rejects.toThrow();
  });
});

describe('JobStoreService with no database', () => {
  const store = new JobStoreService(null);

  it('reports itself disabled', () => {
    expect(store.enabled).toBe(false);
  });

  it('refuses to queue rather than silently dropping a delivery', async () => {
    // Silently returning would leave GitHub believing the review was accepted.
    await expect(store.enqueue(request())).rejects.toBeInstanceOf(PersistenceDisabledError);
  });

  it('refuses to claim', async () => {
    await expect(store.claimNext()).rejects.toBeInstanceOf(PersistenceDisabledError);
  });
});
