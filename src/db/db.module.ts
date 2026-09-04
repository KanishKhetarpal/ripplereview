import { Global, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';
import { AppConfigService } from '../config/app-config.service';
import { MigrationRunner } from './migration-runner';
import { PG_POOL, RunStoreService } from './run-store.service';

/**
 * Persistence, wired only when DATABASE_URL is set.
 *
 * The provider resolves to null otherwise, and RunStoreService treats that as "storage is
 * off" rather than as an error. Requiring Postgres to review a diff on a laptop would be a
 * strange tax for a feature most CLI users never look at.
 */
@Global()
@Module({
  providers: [
    MigrationRunner,
    {
      provide: PG_POOL,
      useFactory: async (
        config: AppConfigService,
        migrations: MigrationRunner,
      ): Promise<Pool | null> => {
        const url = config.databaseUrl;
        if (!url) return null;

        const logger = new Logger('DbModule');
        const pool = new Pool({
          connectionString: url,
          // A review is a handful of statements; a large pool would sit idle holding
          // connections a shared database could use.
          max: 5,
          connectionTimeoutMillis: 10_000,
        });

        // Fail at boot rather than at the first review. By then the graph engine has
        // already parsed the repository and the model has already been paid for.
        await pool.query('SELECT 1');
        await migrations.apply(pool);
        logger.log('connected and schema applied');

        return pool;
      },
      inject: [AppConfigService, MigrationRunner],
    },
    RunStoreService,
  ],
  exports: [RunStoreService, PG_POOL],
})
export class DbModule implements OnApplicationShutdown {
  constructor(private readonly store: RunStoreService) {}

  async onApplicationShutdown(): Promise<void> {
    // Without this a CLI process hangs after its work is done, holding an open socket.
    await closePool(this.store);
  }
}

async function closePool(store: RunStoreService): Promise<void> {
  const pool = (store as unknown as { pool: Pool | null }).pool;
  if (pool) await pool.end();
}
