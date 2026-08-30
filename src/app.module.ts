import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { LlmModule } from './llm/llm.module';
import { ReviewModule } from './review/review.module';

@Module({
  imports: [AppConfigModule, LlmModule, ReviewModule, HealthModule],
})
export class AppModule {}
