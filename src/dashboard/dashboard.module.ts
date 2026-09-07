import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';

/**
 * The dashboard reads stored runs and nothing else.
 *
 * RunStoreService comes from the global DbModule, and resolves against a null pool when no
 * database is configured — which the controller renders as a page rather than an error.
 */
@Module({
  controllers: [DashboardController],
})
export class DashboardModule {}
