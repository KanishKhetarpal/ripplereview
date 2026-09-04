import { Module } from '@nestjs/common';
import { GitHubModule } from '../github/github.module';
import { LlmModule } from '../llm/llm.module';
import { HealthController } from './health.controller';

@Module({
  imports: [LlmModule, GitHubModule],
  controllers: [HealthController],
})
export class HealthModule {}
