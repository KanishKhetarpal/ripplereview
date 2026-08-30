import { Body, Controller, Get, NotImplementedException, Param, Post } from '@nestjs/common';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ReviewResult } from '../core/types/review-result';
import { ReviewRequestDto, reviewRequestSchema } from './review.dto';
import { ReviewService } from './review.service';

@Controller('review')
export class ReviewController {
  constructor(private readonly reviews: ReviewService) {}

  @Post()
  review(
    @Body(new ZodValidationPipe(reviewRequestSchema)) request: ReviewRequestDto,
  ): Promise<ReviewResult> {
    return this.reviews.run(request);
  }

  /** Exercises the pipeline stages that exist, over a fixture change. */
  @Post('demo')
  demo(): Promise<ReviewResult> {
    return this.reviews.runDemo();
  }

  @Get('runs/:id')
  getRun(@Param('id') id: string): never {
    throw new NotImplementedException(
      `Run lookup needs the PostgreSQL store (Phase 4); nothing is persisted yet, so ` +
        `run ${id} cannot be read back.`,
    );
  }
}
