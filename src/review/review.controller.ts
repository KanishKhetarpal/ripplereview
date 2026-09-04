import { Body, Controller, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ReviewResult } from '../core/types/review-result';
import { ReviewRequestDto, reviewRequestSchema } from './review.dto';
import { StoredRunSummary, RunStoreService } from '../db/run-store.service';
import { ReviewService } from './review.service';

@Controller('review')
export class ReviewController {
  constructor(
    private readonly reviews: ReviewService,
    private readonly runs: RunStoreService,
  ) {}

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

  @Get('runs')
  listRuns(@Query('limit') limit?: string): Promise<StoredRunSummary[]> {
    return this.runs.listRuns(limit ? Number(limit) : undefined);
  }

  @Get('runs/:id')
  async getRun(@Param('id') id: string): Promise<ReviewResult> {
    const run = await this.runs.findRun(id);
    // Distinct from PersistenceDisabledError, which the filter maps separately: "no such
    // run" and "runs are not being stored at all" send the reader to different places.
    if (!run) throw new NotFoundException(`no run with id ${id}`);
    return run;
  }
}
