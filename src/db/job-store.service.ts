import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL, PersistenceDisabledError } from './run-store.service';

export type JobState = 'pending' | 'running' | 'done' | 'failed' | 'superseded';

export interface ReviewJob {
  id: number;
  deliveryId: string;
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  baseRef: string;
  cloneUrl: string;
  state: JobState;
  attempts: number;
  lastError: string | null;
  runId: string | null;
}

export interface EnqueueRequest {
  deliveryId: string;
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  baseRef: string;
  cloneUrl: string;
}

export type EnqueueOutcome = 'queued' | 'duplicate';

/** How many times a job is retried before it is left failed. */
export const MAX_ATTEMPTS = 3;

@Injectable()
export class JobStoreService {
  private readonly logger = new Logger(JobStoreService.name);

  constructor(@Optional() @Inject(PG_POOL) private readonly pool: Pool | null) {}

  get enabled(): boolean {
    return this.pool !== null;
  }

  /**
   * Queues one delivery, and supersedes anything older for the same pull request.
   *
   * The delivery id is the idempotency key because GitHub reuses it across retries — a
   * timed-out delivery arrives again with the same id, and the unique constraint turns a
   * retry storm into a single job. `ON CONFLICT DO NOTHING` rather than a prior SELECT:
   * two instances receiving the same retry concurrently would both find nothing and both
   * insert.
   *
   * Superseding matters just as much. Pushing three times in a minute produces three
   * deliveries; reviewing the first two spends model calls to comment on code that has
   * already been replaced, and posts contradictory reviews on the same pull request.
   */
  async enqueue(request: EnqueueRequest): Promise<EnqueueOutcome> {
    if (!this.pool) throw new PersistenceDisabledError();

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const inserted = await client.query(
        `INSERT INTO review_jobs (
           delivery_id, owner, repo, pull_number, head_sha, base_ref, clone_url
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (delivery_id) DO NOTHING
         RETURNING id`,
        [
          request.deliveryId,
          request.owner,
          request.repo,
          request.pullNumber,
          request.headSha,
          request.baseRef,
          request.cloneUrl,
        ],
      );

      if (inserted.rowCount === 0) {
        await client.query('COMMIT');
        return 'duplicate';
      }

      // Only PENDING work is superseded. A job already running has a checkout in flight
      // and will finish; killing it mid-flight would leave a temp directory behind and
      // buy nothing, since the newer job is queued behind it anyway.
      await client.query(
        `UPDATE review_jobs
            SET state = 'superseded', superseded_by = $1, finished_at = now()
          WHERE owner = $2 AND repo = $3 AND pull_number = $4
            AND state = 'pending'
            AND delivery_id <> $1`,
        [request.deliveryId, request.owner, request.repo, request.pullNumber],
      );

      await client.query('COMMIT');
      return 'queued';
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Claims the oldest pending job, or null when there is nothing to do.
   *
   * `FOR UPDATE SKIP LOCKED` is what makes more than one worker safe: a second instance
   * steps over the row the first is claiming instead of blocking on it or, worse, reading
   * it and running the same review twice. Postgres does this properly, which is a large
   * part of why the queue lives here rather than in a separate broker.
   */
  async claimNext(): Promise<ReviewJob | null> {
    if (!this.pool) throw new PersistenceDisabledError();

    const result = await this.pool.query(
      `UPDATE review_jobs
          SET state = 'running', attempts = attempts + 1, claimed_at = now()
        WHERE id = (
          SELECT id FROM review_jobs
           WHERE state = 'pending'
           ORDER BY created_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1
        )
        RETURNING *`,
    );

    return result.rowCount === 0 ? null : toJob(result.rows[0] as Record<string, unknown>);
  }

  async markDone(id: number, runId: string | null): Promise<void> {
    if (!this.pool) throw new PersistenceDisabledError();
    await this.pool.query(
      `UPDATE review_jobs SET state = 'done', run_id = $2, finished_at = now() WHERE id = $1`,
      [id, runId],
    );
  }

  /**
   * Records a failure, and returns the job to the queue if it has attempts left.
   *
   * The attempt count was already incremented when the job was claimed, so a worker that
   * dies mid-review still consumes one — otherwise a job that reliably crashes the process
   * would be retried forever.
   */
  async markFailed(id: number, error: string): Promise<JobState> {
    if (!this.pool) throw new PersistenceDisabledError();

    const result = await this.pool.query(
      `UPDATE review_jobs
          SET state = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'pending' END,
              last_error = $2,
              finished_at = CASE WHEN attempts >= $3 THEN now() ELSE NULL END
        WHERE id = $1
        RETURNING state`,
      [id, error.slice(0, 2000), MAX_ATTEMPTS],
    );

    const state = (result.rows[0] as { state?: string } | undefined)?.state;
    if (state === 'failed') {
      this.logger.error(`job ${id} failed permanently after ${MAX_ATTEMPTS} attempts: ${error}`);
    }
    return (state as JobState) ?? 'failed';
  }

  async findByDelivery(deliveryId: string): Promise<ReviewJob | null> {
    if (!this.pool) throw new PersistenceDisabledError();
    const result = await this.pool.query(`SELECT * FROM review_jobs WHERE delivery_id = $1`, [
      deliveryId,
    ]);
    return result.rowCount === 0 ? null : toJob(result.rows[0] as Record<string, unknown>);
  }

  async pendingCount(): Promise<number> {
    if (!this.pool) throw new PersistenceDisabledError();
    const result = await this.pool.query(
      `SELECT count(*)::int AS n FROM review_jobs WHERE state = 'pending'`,
    );
    return (result.rows[0] as { n: number }).n;
  }

  /**
   * Returns jobs stuck in `running` to the queue.
   *
   * A process killed mid-review leaves its row claimed forever, and nothing else will ever
   * pick it up — the claim is a state change, not a lease. Called at boot, which is the
   * moment a crashed instance is being replaced.
   */
  async requeueStale(olderThanMinutes = 30): Promise<number> {
    if (!this.pool) throw new PersistenceDisabledError();
    const result = await this.pool.query(
      `UPDATE review_jobs
          SET state = CASE WHEN attempts >= $2 THEN 'failed' ELSE 'pending' END,
              last_error = 'reclaimed after the worker stopped without finishing'
        WHERE state = 'running'
          AND claimed_at < now() - ($1 || ' minutes')::interval`,
      [String(olderThanMinutes), MAX_ATTEMPTS],
    );
    return result.rowCount ?? 0;
  }
}

function toJob(row: Record<string, unknown>): ReviewJob {
  return {
    id: Number(row.id),
    deliveryId: String(row.delivery_id),
    owner: String(row.owner),
    repo: String(row.repo),
    pullNumber: Number(row.pull_number),
    headSha: String(row.head_sha),
    baseRef: String(row.base_ref),
    cloneUrl: String(row.clone_url),
    state: String(row.state) as JobState,
    attempts: Number(row.attempts),
    lastError: typeof row.last_error === 'string' ? row.last_error : null,
    runId: typeof row.run_id === 'string' ? row.run_id : null,
  };
}
