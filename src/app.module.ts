import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import { DbModule } from './db/db.module';
import { GitHubModule } from './github/github.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { HealthModule } from './health/health.module';
import { LlmModule } from './llm/llm.module';
import { ReviewModule } from './review/review.module';

@Module({
  imports: [
    AppConfigModule,
    DbModule,
    LlmModule,
    ReviewModule,
    HealthModule,
    GitHubModule,
    DashboardModule,
  ],
})
export class AppModule {}
