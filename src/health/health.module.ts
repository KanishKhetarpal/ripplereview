import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { HealthController } from './health.controller';

@Module({
  imports: [LlmModule],
  controllers: [HealthController],
})
export class HealthModule {}
