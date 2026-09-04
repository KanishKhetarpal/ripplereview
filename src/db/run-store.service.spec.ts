import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChangeImpact } from '../core/types/change-impact';
import { ReviewResult } from '../core/types/review-result';
import { MigrationRunner } from './migration-runner';
import { PersistenceDisabledError, RunStoreService } from './run-store.service';

const DATABASE_URL = process.env.DATABASE_URL;
const HAS_DB = Boolean(DATABASE_URL);

/**
 * Runs against a real PostgreSQL.
 *
 * Everything this file asserts is a guarantee belonging to the database, not to our code:
 * that the schema applies, that a foreign key cascades, that a text[] round-trips, that a
 * rolled-back transaction leaves nothing behind. A mocked pool would only assert that the
 * SQL matches the SQL I wrote, which is the thing least likely to be wrong.
 *
 * Skips locally when DATABASE_URL is unset, and is a HARD FAILURE under CI, where a
 * postgres service container is always present — a skipped integration test on a build
 * server means the pipeline is vouching for a database layer nothing exercised.
 */
if (!HAS_DB && process.env.CI === 'true') {
  throw new Error(
    'DATABASE_URL is unset under CI. The persistence tests cannot run, and skipping them ' +
      'would report a pass for a database layer nothing verified.',
  );
}

function impact(): ChangeImpact {
  return {
    repo: { root: '/repo', baseRef: 'main', headRef: 'feature' },
    changedFiles: ['src/a.ts'],
    changedSymbols: [
      {
        id: 'src/a.ts#doThing',
        name: 'doThing',
        kind: 'function',
        file: 'src/a.ts',
        line: 3,
        changeKind: 'modified',
        exported: true,
      },
    ],
    impactedSites: [],
    cycles: [{ nodeIds: ['src/a.ts', 'src/b.ts'], introducedByChange: true }],
    layerViolations: [],
    instabilityDeltas: [],
    unanalysedFiles: [],
    stats: {
      hopLimit: 3,
      warmUpMs: 400,
      lookupMs: 30,
      lookups: 4,
      moduleCount: 12,
      edgeCount: 20,
      impactedSiteCount: 0,
      durationMs: 900,
    },
  };
}

function result(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    runId: randomUUID(),
    createdAt: new Date().toISOString(),
    repo: { root: '/repo', baseRef: 'main', headRef: 'feature' },
    graphGrounded: true,
    findings: [
      {
        severity: 'high',
        category: 'cross-module-regression',
        file: 'src/b.ts',
        line: 12,
        summary: 'caller not updated',
        rationale: 'still passes one argument',
        evidenceRefs: ['E1', 'E2'],
        confidence: 0.8,
      },
    ],
    rejected: [
      {
        finding: {
          severity: 'medium',
          category: 'architecture',
          file: 'src/c.ts',
          line: 4,
          summary: 'invented layering claim',
          rationale: 'cited nothing',
          evidenceRefs: [],
        },
        reason: 'uncited-structural-claim',
        detail: 'category "architecture" requires at least one evidence citation',
      },
    ],
    evidence: [],
    impact: impact(),
    llm: {
      provider: 'echo',
      model: 'echo-stub',
      usage: [{ inputTokens: 1200, outputTokens: 90, estimatedCostUsd: null }],
      latencyMs: 40,
      attempts: 1,
    },
    totalDurationMs: 1500,
    ...overrides,
  };
}

describe.skipIf(!HAS_DB)('RunStoreService (real PostgreSQL)', () => {
  let pool: Pool;
  let store: RunStoreService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    await new MigrationRunner().apply(pool);
    store = new RunStoreService(pool);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  it('applies the schema idempotently, so a restart is not a failure', async () => {
    await expect(new MigrationRunner().apply(pool)).resolves.toBeUndefined();
  });

  it('reports itself enabled when a pool is present', () => {
    expect(store.enabled).toBe(true);
  });

  it('stores a run and reads it back', async () => {
    const saved = result();
    expect(await store.save(saved)).toBe(true);

    const found = await store.findRun(saved.runId);
    expect(found).not.toBeNull();
    expect(found?.repo.baseRef).toBe('main');
    expect(found?.graphGrounded).toBe(true);
    expect(found?.llm.provider).toBe('echo');
  });

  it('round-trips a finding including its evidence citations', async () => {
    const saved = result();
    await store.save(saved);

    const found = await store.findRun(saved.runId);
    expect(found?.findings).toHaveLength(1);
    // text[] is the column type; a naive implementation stores "E1,E2" and reads back one
    // string, which then cites an evidence id that never existed.
    expect(found?.findings[0].evidenceRefs).toEqual(['E1', 'E2']);
    expect(found?.findings[0].confidence).toBeCloseTo(0.8, 5);
  });

  it('keeps rejected findings, and keeps them separate from kept ones', async () => {
    const saved = result();
    await store.save(saved);

    const found = await store.findRun(saved.runId);
    expect(found?.findings).toHaveLength(1);
    expect(found?.rejected).toHaveLength(1);
    expect(found?.rejected[0].reason).toBe('uncited-structural-claim');
    expect(found?.rejected[0].detail).toContain('requires at least one evidence citation');
  });

  it('round-trips the whole impact snapshot', async () => {
    const saved = result();
    await store.save(saved);

    const found = await store.findRun(saved.runId);
    expect(found?.impact?.stats.warmUpMs).toBe(400);
    expect(found?.impact?.cycles[0].introducedByChange).toBe(true);
    expect(found?.impact?.changedSymbols[0].id).toBe('src/a.ts#doThing');
  });

  it('stores a null cost rather than inventing one', async () => {
    const saved = result();
    await store.save(saved);

    const row = await pool.query('SELECT estimated_cost_usd FROM runs WHERE id = $1', [
      saved.runId,
    ]);
    expect(row.rows[0].estimated_cost_usd).toBeNull();
  });

  it('sums cost only when every call reported one', async () => {
    const saved = result({
      llm: {
        provider: 'openai',
        model: 'gpt-4o-mini',
        usage: [
          { inputTokens: 100, outputTokens: 10, estimatedCostUsd: 0.001 },
          { inputTokens: 100, outputTokens: 10, estimatedCostUsd: 0.002 },
        ],
        latencyMs: 10,
        attempts: 2,
      },
    });
    await store.save(saved);

    const row = await pool.query('SELECT estimated_cost_usd FROM runs WHERE id = $1', [
      saved.runId,
    ]);
    expect(Number(row.rows[0].estimated_cost_usd)).toBeCloseTo(0.003, 6);
  });

  it('refuses to sum a partial cost, which would look authoritative and be wrong', async () => {
    const saved = result({
      llm: {
        provider: 'openai',
        model: 'gpt-4o-mini',
        usage: [
          { inputTokens: 100, outputTokens: 10, estimatedCostUsd: 0.001 },
          { inputTokens: 100, outputTokens: 10, estimatedCostUsd: null },
        ],
        latencyMs: 10,
        attempts: 2,
      },
    });
    await store.save(saved);

    const row = await pool.query('SELECT estimated_cost_usd FROM runs WHERE id = $1', [
      saved.runId,
    ]);
    expect(row.rows[0].estimated_cost_usd).toBeNull();
  });

  it('sums prompt tokens across repair attempts', async () => {
    const saved = result({
      llm: {
        provider: 'echo',
        model: 'echo-stub',
        usage: [
          { inputTokens: 1000, outputTokens: 50, estimatedCostUsd: null },
          { inputTokens: 1100, outputTokens: 60, estimatedCostUsd: null },
        ],
        latencyMs: 80,
        attempts: 2,
      },
    });
    await store.save(saved);

    const found = await store.findRun(saved.runId);
    expect(found?.llm.usage[0].inputTokens).toBe(2100);
    expect(found?.llm.attempts).toBe(2);
  });

  it('answers null for an unknown run', async () => {
    await expect(store.findRun(randomUUID())).resolves.toBeNull();
  });

  it('cascades findings and the snapshot when a run is deleted', async () => {
    const saved = result();
    await store.save(saved);
    await pool.query('DELETE FROM runs WHERE id = $1', [saved.runId]);

    const findings = await pool.query('SELECT 1 FROM findings WHERE run_id = $1', [saved.runId]);
    const snapshot = await pool.query('SELECT 1 FROM impact_snapshots WHERE run_id = $1', [
      saved.runId,
    ]);
    expect(findings.rowCount).toBe(0);
    expect(snapshot.rowCount).toBe(0);
  });

  it('leaves nothing behind when a save fails part-way', async () => {
    // A finding with a null summary violates NOT NULL, and the run row is inserted first.
    // Without the transaction a failed save would leave an orphan run with no findings,
    // which reads back as a review that legitimately found nothing.
    const broken = result();
    broken.findings[0] = {
      ...broken.findings[0],
      summary: null as unknown as string,
    };

    expect(await store.save(broken)).toBe(false);
    const row = await pool.query('SELECT 1 FROM runs WHERE id = $1', [broken.runId]);
    expect(row.rowCount).toBe(0);
  });

  it('never throws when storage fails, so a completed review is not lost', async () => {
    const broken = result();
    broken.findings[0] = { ...broken.findings[0], summary: null as unknown as string };
    await expect(store.save(broken)).resolves.toBe(false);
  });

  it('lists runs newest first', async () => {
    const older = result({ createdAt: new Date(Date.now() - 60_000).toISOString() });
    const newer = result({ createdAt: new Date().toISOString() });
    await store.save(older);
    await store.save(newer);

    const listed = await store.listRuns(50);
    const olderIndex = listed.findIndex((r) => r.runId === older.runId);
    const newerIndex = listed.findIndex((r) => r.runId === newer.runId);
    expect(newerIndex).toBeLessThan(olderIndex);
  });

  it('stores a diff-only run distinguishably from a grounded one', async () => {
    const baseline = result({ graphGrounded: false, impact: null });
    await store.save(baseline);

    const found = await store.findRun(baseline.runId);
    expect(found?.graphGrounded).toBe(false);
    expect(found?.impact).toBeNull();
  });
});

describe('RunStoreService with no database', () => {
  const store = new RunStoreService(null);

  it('reports itself disabled', () => {
    expect(store.enabled).toBe(false);
  });

  it('silently declines to store, so a laptop review still succeeds', async () => {
    await expect(store.save(result())).resolves.toBe(false);
  });

  it('refuses a read distinctly, rather than pretending the run does not exist', async () => {
    // "There is no such run" and "runs are not being stored at all" send the reader to
    // completely different places.
    await expect(store.findRun(randomUUID())).rejects.toBeInstanceOf(PersistenceDisabledError);
  });

  it('refuses a listing the same way', async () => {
    await expect(store.listRuns()).rejects.toBeInstanceOf(PersistenceDisabledError);
  });
});
