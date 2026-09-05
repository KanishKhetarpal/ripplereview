import { Module } from '@nestjs/common';
import { IngestModule } from '../ingest/ingest.module';
import { ReviewModule } from '../review/review.module';
import { GitHubClient } from './github-client';
import { PrCheckoutService } from './pr-checkout.service';
import { ReviewWorkerService } from './review-worker.service';
import { ReviewCommentBuilder } from './review-comment-builder';
import { GitHubWebhookController } from './webhook.controller';

@Module({
  imports: [ReviewModule, IngestModule],
  controllers: [GitHubWebhookController],
  providers: [GitHubClient, ReviewCommentBuilder, PrCheckoutService, ReviewWorkerService],
  exports: [GitHubClient, ReviewCommentBuilder, ReviewWorkerService],
})
export class GitHubModule {}
