import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { JobStoreService, ReviewJob } from '../db/job-store.service';
import { GitRepoService } from '../ingest/git-repo.service';
import { ReviewService } from '../review/review.service';
import { GitHubClient } from './github-client';
import { PrCheckoutService } from './pr-checkout.service';
import { ReviewCommentBuilder } from './review-comment-builder';

export type JobOutcome = 'reviewed' | 'failed' | 'idle';

const POLL_INTERVAL_MS = 5_000;

/**
 * Drains the review queue.
 *
 * In-process and polling, rather than a broker. The queue already lives in the Postgres
 * this project needed anyway, `FOR UPDATE SKIP LOCKED` makes several instances safe, and
 * a review takes seconds to minutes — a five-second poll is noise against that. Redis
 * would be a second piece of infrastructure to run, monitor and explain, bought with the
 * latency of one poll.
 */
@Injectable()
export class ReviewWorkerService implements OnApplicationShutdown {
  private readonly logger = new Logger(ReviewWorkerService.name);
  private timer: NodeJS.Timeout | null = null;
  private draining = false;
  private stopped = false;

  constructor(
    private readonly jobs: JobStoreService,
    private readonly checkouts: PrCheckoutService,
    private readonly reviews: ReviewService,
    private readonly comments: ReviewCommentBuilder,
    private readonly github: GitHubClient,
    private readonly git: GitRepoService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Starts polling. Called explicitly rather than from a lifecycle hook, so a CLI run
   * never quietly starts draining a shared queue on someone's laptop.
   */
  async start(): Promise<void> {
    if (!this.jobs.enabled) {
      this.logger.warn('no database configured; the review queue is not being drained');
      return;
    }

    // A process killed mid-review leaves its row claimed forever — the claim is a state
    // change, not a lease — and boot is exactly when a crashed instance is being replaced.
    const reclaimed = await this.jobs.requeueStale();
    if (reclaimed > 0) this.logger.warn(`requeued ${reclaimed} job(s) left running`);

    this.timer = setInterval(() => void this.drain(), POLL_INTERVAL_MS);
    this.logger.log('review worker started');
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  /** Processes everything currently queued. Exposed so a test can drive it deterministically. */
  async drain(): Promise<number> {
    // Re-entrancy guard: a review can outlast the poll interval, and a second tick
    // claiming another job would multiply concurrency by however long reviews take.
    if (this.draining || this.stopped) return 0;
    this.draining = true;

    let processed = 0;
    try {
      while (!this.stopped) {
        const outcome = await this.runNext();
        if (outcome === 'idle') break;
        processed++;
      }
    } finally {
      this.draining = false;
    }
    return processed;
  }

  /** Claims and processes one job. */
  async runNext(): Promise<JobOutcome> {
    const job = await this.jobs.claimNext();
    if (!job) return 'idle';

    this.logger.log(
      `reviewing ${job.owner}/${job.repo}#${job.pullNumber} at ${job.headSha.slice(0, 8)} ` +
        `(delivery ${job.deliveryId}, attempt ${job.attempts})`,
    );

    try {
      const runId = await this.review(job);
      await this.jobs.markDone(job.id, runId);
      return 'reviewed';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const state = await this.jobs.markFailed(job.id, message);
      this.logger.warn(`job ${job.id} ${state === 'failed' ? 'failed' : 'will retry'}: ${message}`);
      return 'failed';
    }
  }

  private async review(job: ReviewJob): Promise<string | null> {
    const checkout = await this.checkouts.checkout({
      cloneUrl: job.cloneUrl,
      headSha: job.headSha,
      baseRef: job.baseRef,
      token: this.config.githubToken,
    });

    try {
      const result = await this.reviews.run({
        repoPath: checkout.path,
        baseRef: checkout.baseSha,
        headRef: 'HEAD',
      });

      // The change set is re-read rather than carried out of the review, because the
      // comment builder needs the parsed hunks to know which lines GitHub will accept a
      // comment on, and that is the one thing it must not guess.
      const changeSet = await this.git.changeSet(checkout.path, checkout.baseSha, 'HEAD');
      const review = this.comments.build(result, changeSet.files);

      if (this.github.configured) {
        await this.github.postReview(
          {
            owner: job.owner,
            repo: job.repo,
            pullNumber: job.pullNumber,
            commitId: job.headSha,
          },
          review,
        );
      } else {
        // Not a failure: a run configured without a token still produces and stores a
        // review. Retrying it would never succeed, and marking it failed would hide a
        // result that exists.
        this.logger.warn(
          `no GITHUB_TOKEN, so run ${result.runId} was not posted to ` +
            `${job.owner}/${job.repo}#${job.pullNumber}`,
        );
      }

      return result.runId;
    } finally {
      // Always, on every path. A worker that leaks a clone per job fills the disk of a
      // long-running instance, and the failure looks nothing like its cause.
      checkout.dispose();
    }
  }
}
