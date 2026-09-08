import { rmSync } from 'node:fs';
import { Pool } from 'pg';
import { Project } from 'ts-morph';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DuplicateMatch } from '../core/types/change-impact';
import { GitRepoService } from '../ingest/git-repo.service';
import { DuplicateDetectorService } from './duplicate-detector.service';
import { DuplicateStoreService } from './duplicate-store.service';
import { StructuralEmbedder } from './embedding.provider';
import { CrossRepoPair, buildCrossRepositoryPair } from './__fixtures__/build-cross-repo-pair';

const DATABASE_URL = process.env.DATABASE_URL;
const HAS_DB = Boolean(DATABASE_URL);

/**
 * Cross-repository duplicate detection, end to end, over two real git repositories.
 *
 * The store's own spec covers the SQL with synthetic vectors. This covers the claim: that
 * reviewing one repository and then another tells the second what it re-implemented from
 * the first. Everything in the path is real — git, ts-morph, the fingerprints, pgvector —
 * because each of those steps is somewhere the claim could quietly stop being true.
 *
 * Skips locally when DATABASE_URL is unset, and is a HARD FAILURE under CI, where a
 * pgvector service container is always present.
 */
if (!HAS_DB && process.env.CI === 'true') {
  throw new Error(
    'DATABASE_URL is unset under CI. The cross-repository test cannot run, and skipping it ' +
      'would report a pass for the one feature that needs a database to mean anything.',
  );
}

describe.skipIf(!HAS_DB)('cross-repository duplicate detection', () => {
  let pair: CrossRepoPair;
  let pool: Pool;
  let store: DuplicateStoreService;
  let detector: DuplicateDetectorService;
  let serviceMatches: DuplicateMatch[];

  const git = new GitRepoService();
  const embedder = new StructuralEmbedder();

  const review = async (repo: { path: string; id: string }): Promise<DuplicateMatch[]> => {
    const repoRoot = repo.path.replace(/\\/g, '/');
    const project = new Project({
      tsConfigFilePath: `${repoRoot}/tsconfig.json`,
      skipFileDependencyResolution: true,
    });
    const changeSet = await git.changeSet(repo.path, 'HEAD~1', 'HEAD');
    return detector.detect({ project, repoRoot, repoId: repo.id, changeSet });
  };

  beforeAll(async () => {
    pair = buildCrossRepositoryPair();

    pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    store = new DuplicateStoreService(pool, embedder);
    await store.initialise(embedder.dimensions);
    await pool.query('DELETE FROM function_fingerprints WHERE repo LIKE $1', ['test.example/%']);

    detector = new DuplicateDetectorService(embedder, store);

    // The library is reviewed first, which is what puts it in the corpus. Then the service,
    // which is where the copy arrives.
    await review(pair.library);
    serviceMatches = await review(pair.service);
  }, 180_000);

  afterAll(async () => {
    await pool?.query('DELETE FROM function_fingerprints WHERE repo LIKE $1', ['test.example/%']);
    await pool?.end();
    rmSync(pair.library.path, { recursive: true, force: true });
    rmSync(pair.service.path, { recursive: true, force: true });
  });

  it('has a usable vector store, or the rest of this file proves nothing', () => {
    expect(store.available).toBe(true);
  });

  it('tells the second repository what it re-implemented from the first', () => {
    const crossRepo = serviceMatches.filter((match) => match.scope === 'other-repository');

    expect(crossRepo).toHaveLength(1);
    expect(crossRepo[0].name).toBe('calculateRefundShare');
    expect(crossRepo[0].file).toBe('src/refund.ts');
    expect(crossRepo[0].duplicateOf.name).toBe('prorateCharge');
    expect(crossRepo[0].duplicateOf.file).toBe('src/shared/proration.ts');
    expect(crossRepo[0].similarity).toBe(1);
  });

  it('names the repository the original lives in', () => {
    // Without this the finding says a file and a line that do not exist in the repository
    // being reviewed, which reads as a hallucination rather than a cross-repository hit.
    const [match] = serviceMatches.filter((entry) => entry.scope === 'other-repository');
    expect(match.duplicateOf.repo).toBe(pair.library.id);
  });

  it('finds nothing in the repository under review, so the match can only be cross-repo', () => {
    // The service repository has no proration.ts. If an in-repository match appeared, the
    // test above would pass for the wrong reason.
    expect(serviceMatches.filter((match) => match.scope === 'repository')).toEqual([]);
  });

  it('is the database that provides it: the same review finds nothing without one', async () => {
    // The control. It separates "the corpus works" from "these two functions happen to
    // match anyway", which no amount of asserting on the positive case can do.
    const offline = new DuplicateDetectorService(
      embedder,
      new DuplicateStoreService(null, embedder),
    );
    const repoRoot = pair.service.path.replace(/\\/g, '/');
    const project = new Project({
      tsConfigFilePath: `${repoRoot}/tsconfig.json`,
      skipFileDependencyResolution: true,
    });
    const changeSet = await git.changeSet(pair.service.path, 'HEAD~1', 'HEAD');

    const matches = await offline.detect({
      project,
      repoRoot,
      repoId: pair.service.id,
      changeSet,
    });

    expect(matches).toEqual([]);
  }, 60_000);

  it('records the reviewed repository under its own id', async () => {
    const rows = await pool.query<{ repo: string; symbol: string }>(
      'SELECT repo, symbol FROM function_fingerprints WHERE repo LIKE $1 ORDER BY repo, symbol',
      ['test.example/%'],
    );

    const byRepo = new Map<string, string[]>();
    for (const row of rows.rows) {
      byRepo.set(row.repo, [...(byRepo.get(row.repo) ?? []), row.symbol]);
    }

    expect(byRepo.get(pair.library.id)).toContain('prorateCharge');
    // The service is recorded too, so a third repository copying from IT would be told.
    expect(byRepo.get(pair.service.id)).toContain('calculateRefundShare');
  });
});
