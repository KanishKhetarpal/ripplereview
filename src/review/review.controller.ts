import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
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
  async getRun(
    // Validated before it reaches the database. Without this a non-UUID path segment is
    // handed straight to Postgres, which raises `invalid input syntax for type uuid` —
    // an unmapped error, so the caller gets a bare 500 for what is plainly a bad request.
    // Found by CI, where a real database is configured; with persistence off the id was
    // never used and the fault was invisible.
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<ReviewResult> {
    const run = await this.runs.findRun(id);
    // Distinct from PersistenceDisabledError, which the filter maps separately: "no such
    // run" and "runs are not being stored at all" send the reader to different places.
    if (!run) throw new NotFoundException(`no run with id ${id}`);
    return run;
  }
}
