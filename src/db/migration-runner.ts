import { Injectable, Logger } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

/**
 * Applies the schema.
 *
 * One idempotent file rather than a numbered migration chain, because the schema is three
 * tables and nothing has shipped against an older version of it yet. The moment a column
 * has to change under live data, this becomes a numbered chain — doing that now would be
 * ceremony around a file that has never needed to evolve.
 *
 * Everything runs in one transaction: a half-applied schema is worse than none, because
 * the next boot would find the tables it checks for and skip the rest.
 */
@Injectable()
export class MigrationRunner {
  private readonly logger = new Logger(MigrationRunner.name);

  async apply(pool: Pool): Promise<void> {
    const sql = readFileSync(schemaPath(), 'utf8');
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
      this.logger.log('schema applied');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

/**
 * schema.sql sits beside this file in src/ and beside the compiled JS in dist/, so reading
 * it relative to __dirname works from both.
 *
 * The dist half is NOT automatic — `nest build` copies no non-TS assets by default, and
 * the first build of this file produced a dist/db with no schema.sql in it. That fails
 * only when a built artefact starts against a real database, which is to say only in
 * production. `assets` in nest-cli.json is what copies it.
 */
export function schemaPath(): string {
  return join(__dirname, 'schema.sql');
}
