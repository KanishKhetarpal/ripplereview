import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../db/run-store.service';
import { EMBEDDER, Embedder } from './embedding.provider';
import { FunctionUnit } from './function-unit';

export interface StoredMatch {
  repo: string;
  file: string;
  name: string;
  line: number;
  similarity: number;
}

export interface StoreSearchOptions {
  /** The repository under review. Its own functions are already covered in memory. */
  excludeRepo: string;
  embedder: Embedder;
  minSimilarity: number;
  limit: number;
}

/** Rows written per statement. Large enough to be one round trip per file, roughly. */
const UPSERT_CHUNK = 500;

/**
 * A corpus of function fingerprints spanning every repository ever reviewed.
 *
 * The reason this is worth a database at all: the in-memory index can only compare a change
 * against code that is checked out. "You already wrote this, in the other service" is a
 * question no amount of local analysis can answer.
 *
 * Deliberately NOT part of schema.sql. That file is applied on every boot for anyone with
 * a DATABASE_URL, in one transaction — so a `CREATE EXTENSION vector` in it would take a
 * plain PostgreSQL from "duplicate detection is unavailable" to "the application does not
 * start". The extension is common but far from universal, and on a managed database it is
 * often not the application's to install. So this schema is applied separately, failure is
 * caught, and everything degrades to the in-memory index.
 */
@Injectable()
export class DuplicateStoreService implements OnModuleInit {
  private readonly logger = new Logger(DuplicateStoreService.name);
  private dimensions: number | null = null;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool | null,
    @Inject(EMBEDDER) private readonly embedder: Embedder,
  ) {}

  /** True only once the extension, the table and the index are all actually in place. */
  get available(): boolean {
    return this.pool !== null && this.dimensions !== null;
  }

  async onModuleInit(): Promise<void> {
    // The column's width is the configured embedder's, so swapping the embedder for a
    // wider one needs no edit here — only a corpus that has to be rebuilt, which is what
    // the embedder name and version columns make visible.
    await this.initialise(this.embedder.dimensions);
  }

  /**
   * Installs the vector schema, or decides the feature is off.
   *
   * Never throws. A missing extension is a normal state of the world, not a fault: the
   * review still runs, and duplicates within the repository under review are still found,
   * because those never needed the database.
   */
  async initialise(dimensions: number): Promise<void> {
    if (!this.pool) return;

    if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 16_000) {
      // Interpolated into DDL below, so it is checked rather than trusted. pgvector's own
      // ceiling for an indexable column is 2,000; the wider bound here is just sanity.
      this.logger.warn(`refusing to build a vector column of ${dimensions} dimension(s)`);
      return;
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      await client.query(`
        CREATE TABLE IF NOT EXISTS function_fingerprints (
          repo                TEXT        NOT NULL,
          file                TEXT        NOT NULL,
          symbol              TEXT        NOT NULL,
          start_line          INTEGER     NOT NULL,
          -- Which representation produced the vector, and which revision of it. Vectors
          -- from different embedders, or from different versions of the same one, are not
          -- comparable: the same function lands somewhere else in the space. Filtering on
          -- both is what stops a tokeniser change silently ending all matching instead of
          -- visibly invalidating a corpus.
          embedder            TEXT        NOT NULL,
          fingerprint_version INTEGER     NOT NULL,
          token_count         INTEGER     NOT NULL,
          embedding           VECTOR(${dimensions}) NOT NULL,
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (repo, file, symbol, start_line, embedder)
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS function_fingerprints_embedding_idx
          ON function_fingerprints USING hnsw (embedding vector_cosine_ops)
      `);
      await client.query('COMMIT');

      this.dimensions = dimensions;
      this.logger.log('vector store ready — cross-repository duplicate detection is on');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      this.dimensions = null;
      this.logger.warn(
        'vector store unavailable, so duplicate detection is limited to the repository ' +
          `under review: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      client.release();
    }
  }

  async search(query: Float64Array, options: StoreSearchOptions): Promise<StoredMatch[]> {
    if (!this.pool || !this.compatible(options.embedder)) return [];

    // `<=>` is cosine DISTANCE. Both operands are unit vectors, so similarity is 1 - it.
    const result = await this.pool.query<{
      repo: string;
      file: string;
      symbol: string;
      start_line: number;
      distance: string;
    }>(
      `SELECT repo, file, symbol, start_line, embedding <=> $1 AS distance
         FROM function_fingerprints
        WHERE repo <> $2
          AND embedder = $3
          AND fingerprint_version = $4
        ORDER BY embedding <=> $1
        LIMIT $5`,
      [
        toVectorLiteral(query),
        options.excludeRepo,
        options.embedder.name,
        options.embedder.version,
        options.limit,
      ],
    );

    return result.rows
      .map((row) => ({
        repo: row.repo,
        file: row.file,
        name: row.symbol,
        line: row.start_line,
        similarity: 1 - Number(row.distance),
      }))
      .filter((match) => match.similarity >= options.minSimilarity);
  }

  /**
   * Records this repository's fingerprints, replacing whatever was there before.
   *
   * A full sweep of the repository, so anything not refreshed by this pass no longer
   * exists — deleted, renamed or moved. Rows older than this run are removed rather than
   * left behind, because a corpus that only ever grows would go on reporting duplicates of
   * functions that were deleted months ago, citing a file and a line that are not there.
   *
   * Best-effort throughout. The review has already been produced and paid for.
   */
  async remember(
    repo: string,
    units: FunctionUnit[],
    vectors: Float64Array[],
    embedder: Embedder,
  ): Promise<void> {
    if (!this.pool || !this.compatible(embedder) || units.length === 0) return;

    const startedAt = new Date();

    try {
      for (let offset = 0; offset < units.length; offset += UPSERT_CHUNK) {
        const chunk = units.slice(offset, offset + UPSERT_CHUNK);
        const values: unknown[] = [];
        const rows: string[] = [];

        chunk.forEach((unit, i) => {
          const base = i * 8;
          rows.push(
            `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`,
          );
          values.push(
            repo,
            unit.file,
            unit.name,
            unit.line,
            embedder.name,
            embedder.version,
            unit.tokens.length,
            toVectorLiteral(vectors[offset + i]),
          );
        });

        await this.pool.query(
          `INSERT INTO function_fingerprints
             (repo, file, symbol, start_line, embedder, fingerprint_version, token_count, embedding)
           VALUES ${rows.join(', ')}
           ON CONFLICT (repo, file, symbol, start_line, embedder) DO UPDATE
             SET embedding = EXCLUDED.embedding,
                 fingerprint_version = EXCLUDED.fingerprint_version,
                 token_count = EXCLUDED.token_count,
                 updated_at = now()`,
          values,
        );
      }

      await this.pool.query(
        `DELETE FROM function_fingerprints
          WHERE repo = $1 AND embedder = $2 AND updated_at < $3`,
        [repo, embedder.name, startedAt],
      );
    } catch (error) {
      this.logger.warn(
        `could not record fingerprints for ${repo}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  /**
   * An embedder of a different width cannot use a column built for this one.
   *
   * Reported rather than attempted: the insert would fail per statement with a type error
   * that reads like a bug, and the search would return nothing with no explanation at all.
   */
  private compatible(embedder: Embedder): boolean {
    if (this.dimensions === null) return false;
    if (embedder.dimensions === this.dimensions) return true;

    this.logger.warn(
      `the vector store holds ${this.dimensions}-dimension vectors but the ${embedder.name} ` +
        `embedder produces ${embedder.dimensions}; cross-repository matching is off`,
    );
    return false;
  }
}

/** pgvector's text input format. */
export function toVectorLiteral(vector: Float64Array): string {
  return `[${Array.from(vector).join(',')}]`;
}
