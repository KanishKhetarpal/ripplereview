import { Module } from '@nestjs/common';
import { GitHubClient } from './github-client';
import { ReviewCommentBuilder } from './review-comment-builder';
import { GitHubWebhookController } from './webhook.controller';

@Module({
  controllers: [GitHubWebhookController],
  providers: [GitHubClient, ReviewCommentBuilder],
  exports: [GitHubClient, ReviewCommentBuilder],
})
export class GitHubModule {}
