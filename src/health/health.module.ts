import { Module } from '@nestjs/common';
import { DuplicatesModule } from '../duplicates/duplicates.module';
import { GitHubModule } from '../github/github.module';
import { LlmModule } from '../llm/llm.module';
import { HealthController } from './health.controller';

@Module({
  imports: [LlmModule, GitHubModule, DuplicatesModule],
  controllers: [HealthController],
})
export class HealthModule {}
