import { Module } from '@nestjs/common';
import { GraphModule } from '../graph/graph.module';
import { IngestModule } from '../ingest/ingest.module';
import { LlmModule } from '../llm/llm.module';
import { ImpactRenderer } from '../output/impact-renderer';
import { ReportRenderer } from '../output/report-renderer';
import { ImpactService } from './impact.service';
import { ReviewController } from './review.controller';
import { ReviewService } from './review.service';

@Module({
  imports: [LlmModule, GraphModule, IngestModule],
  controllers: [ReviewController],
  providers: [ReviewService, ImpactService, ReportRenderer, ImpactRenderer],
  exports: [ReviewService, ImpactService, ReportRenderer, ImpactRenderer],
})
export class ReviewModule {}
