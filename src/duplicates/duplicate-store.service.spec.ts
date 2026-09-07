import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fingerprint } from './code-fingerprint';
import { DuplicateStoreService } from './duplicate-store.service';
import { StructuralEmbedder } from './embedding.provider';
import { FunctionUnit } from './function-unit';

const DATABASE_URL = process.env.DATABASE_URL;
const HAS_DB = Boolean(DATABASE_URL);

/**
 * The vector store against a real PostgreSQL with a real pgvector extension.
 *
 * Everything asserted here belongs to the database rather than to our code: that the
 * extension installs, that a VECTOR column round-trips a 256-wide unit vector, that `<=>`
 * orders by cosine distance, that the primary key makes a second pass an update rather
 * than a duplicate row. A mocked pool could only assert that the SQL matches the SQL I
 * wrote, which is the part least likely to be wrong.
 *
 * Skips locally when DATABASE_URL is unset, and is a HARD FAILURE under CI, where the
 * service container is always present.
 */
if (!HAS_DB && process.env.CI === 'true') {
  throw new Error(
    'DATABASE_URL is unset under CI. The vector store tests cannot run, and skipping them ' +
      'would report a pass for cross-repository duplicate detection that nothing verified.',
  );
}

const embedder = new StructuralEmbedder();

function unit(name: string, seed: string, length = 80): FunctionUnit {
  return {
    id: `src/${name}.ts#${name}@1`,
    file: `src/${name}.ts`,
    name,
    line: 1,
    endLine: 20,
    tokens: Array.from({ length }, (_, i) => `${seed}${i % 13}`),
  };
}

describe.skipIf(!HAS_DB)('DuplicateStoreService (real pgvector)', () => {
  const REPO_A = 'test.example/repo-a';
  const REPO_B = 'test.example/repo-b';

  let pool: Pool;
  let store: DuplicateStoreService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    store = new DuplicateStoreService(pool, embedder);
    await store.initialise(embedder.dimensions);
    await pool.query('DELETE FROM function_fingerprints WHERE repo LIKE $1', ['test.example/%']);
  }, 60_000);

  afterAll(async () => {
    await pool.query('DELETE FROM function_fingerprints WHERE repo LIKE $1', ['test.example/%']);
    await pool.end();
  });

  it('installs the extension and reports itself available', () => {
    expect(store.available).toBe(true);
  });

  it('finds a function copied into a DIFFERENT repository', () => {
    // The whole reason this needs a database: repo A is not checked out, so no amount of
    // local analysis could reach it.
    return (async () => {
      const shared = unit('shared', 'X');
      await store.remember(REPO_A, [shared], [fingerprint(shared.tokens)], embedder);

      const hits = await store.search(fingerprint(shared.tokens), {
        excludeRepo: REPO_B,
        embedder,
        minSimilarity: 0.85,
        limit: 5,
      });

      expect(hits.map((hit) => hit.repo)).toContain(REPO_A);
      expect(hits[0].name).toBe('shared');
      expect(hits[0].similarity).toBeCloseTo(1, 5);
    })();
  });

  it('never returns the repository under review', async () => {
    // Its own functions are already covered by the in-memory index, and returning them
    // here would report every function as a duplicate of itself.
    const own = unit('own', 'Y');
    await store.remember(REPO_B, [own], [fingerprint(own.tokens)], embedder);

    const hits = await store.search(fingerprint(own.tokens), {
      excludeRepo: REPO_B,
      embedder,
      minSimilarity: 0.85,
      limit: 5,
    });

    expect(hits.map((hit) => hit.repo)).not.toContain(REPO_B);
  });

  it('applies the similarity floor rather than returning the nearest row regardless', async () => {
    // `<=>` always returns SOMETHING; ordering by distance with a LIMIT and no floor would
    // report the least-unlike function in the corpus as a duplicate every single time.
    const unrelated = unit('unrelated', 'Q');

    const hits = await store.search(fingerprint(unrelated.tokens), {
      excludeRepo: REPO_B,
      embedder,
      minSimilarity: 0.85,
      limit: 5,
    });

    expect(hits).toEqual([]);
  });

  it('ignores vectors written by a different embedder version', async () => {
    // A tokeniser change moves every function in the space. Comparing across versions
    // would not fail; it would quietly return nonsense.
    const older = { ...embedder, version: embedder.version + 1 } as typeof embedder;
    const shared = unit('shared', 'X');

    const hits = await store.search(fingerprint(shared.tokens), {
      excludeRepo: REPO_B,
      embedder: older,
      minSimilarity: 0.85,
      limit: 5,
    });

    expect(hits).toEqual([]);
  });

  it('replaces a repository snapshot rather than accumulating one per run', async () => {
    // A corpus that only grows goes on citing functions that were deleted months ago, at
    // a file and line that no longer exist.
    const before = unit('gone', 'Z');
    await store.remember(REPO_A, [before], [fingerprint(before.tokens)], embedder);

    const after = unit('kept', 'W');
    await store.remember(REPO_A, [after], [fingerprint(after.tokens)], embedder);

    const rows = await pool.query<{ symbol: string }>(
      'SELECT symbol FROM function_fingerprints WHERE repo = $1 ORDER BY symbol',
      [REPO_A],
    );

    expect(rows.rows.map((row) => row.symbol)).toEqual(['kept']);
  });
});

describe('DuplicateStoreService without a usable database', () => {
  it('is unavailable and silent when no database is configured', async () => {
    const store = new DuplicateStoreService(null, embedder);
    await store.initialise(embedder.dimensions);

    expect(store.available).toBe(false);
    await expect(
      store.search(fingerprint(unit('a', 'A').tokens), {
        excludeRepo: 'x',
        embedder,
        minSimilarity: 0.85,
        limit: 5,
      }),
    ).resolves.toEqual([]);
  });

  it('degrades instead of throwing when the extension cannot be installed', async () => {
    // The common case on a managed database, where CREATE EXTENSION is not the
    // application's to run. It must cost cross-repository matching and nothing else — a
    // throw here would take down a review that never needed the database.
    const failing = {
      connect: () =>
        Promise.resolve({
          query: (sql: string) =>
            /CREATE EXTENSION/i.test(sql)
              ? Promise.reject(new Error('permission denied to create extension "vector"'))
              : Promise.resolve({ rows: [] }),
          release: () => undefined,
        }),
    } as unknown as Pool;

    const store = new DuplicateStoreService(failing, embedder);
    await expect(store.initialise(embedder.dimensions)).resolves.toBeUndefined();
    expect(store.available).toBe(false);
  });

  it('refuses to build a vector column from an implausible width', async () => {
    // The width is interpolated into DDL, so it is validated rather than trusted.
    let ddl = '';
    const recording = {
      connect: () =>
        Promise.resolve({
          query: (sql: string) => {
            ddl += sql;
            return Promise.resolve({ rows: [] });
          },
          release: () => undefined,
        }),
    } as unknown as Pool;

    const store = new DuplicateStoreService(recording, embedder);
    await store.initialise(-1);

    expect(store.available).toBe(false);
    expect(ddl).toBe('');
  });
});
