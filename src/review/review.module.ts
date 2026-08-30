import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { ReportRenderer } from '../output/report-renderer';
import { ReviewController } from './review.controller';
import { ReviewService } from './review.service';

@Module({
  imports: [LlmModule],
  controllers: [ReviewController],
  providers: [ReviewService, ReportRenderer],
  exports: [ReviewService, ReportRenderer],
})
export class ReviewModule {}
