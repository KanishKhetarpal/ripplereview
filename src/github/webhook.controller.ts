import {
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { AppConfigService } from '../config/app-config.service';
import { JobStoreService } from '../db/job-store.service';
import { verifySignature } from './webhook-signature';

export interface WebhookAck {
  received: true;
  action: 'queued' | 'ignored';
  reason?: string;
}

/**
 * The GitHub webhook door.
 *
 * It verifies, enqueues, and returns. Reviewing takes seconds to minutes — a repository
 * has to be cloned, parsed and sent to a model — and GitHub times a delivery out after ten
 * seconds and then retries it. Doing the work inline would guarantee duplicate reviews on
 * every large change; a worker drains the queue separately.
 */
@Controller('webhooks/github')
export class GitHubWebhookController {
  private readonly logger = new Logger(GitHubWebhookController.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly jobs: JobStoreService,
  ) {}

  @Post()
  @HttpCode(202)
  async handle(
    @Req() request: Request,
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Headers('x-github-event') event: string | undefined,
    @Headers('x-github-delivery') delivery: string | undefined,
  ): Promise<WebhookAck> {
    // The RAW body, captured by the rawBody middleware. Re-serialising the parsed object
    // would change the bytes and every signature would fail.
    const raw = (request as Request & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);

    const verdict = verifySignature(raw, signature, this.config.githubWebhookSecret);
    if (!verdict.valid) {
      // The reason is logged, never returned. Telling a caller whether the secret is
      // unset, the header is missing or the digest is wrong is free reconnaissance.
      this.logger.warn(`rejected webhook delivery: ${verdict.reason}`);
      throw new UnauthorizedException('invalid signature');
    }

    if (event !== 'pull_request') {
      return { received: true, action: 'ignored', reason: `event ${String(event)}` };
    }

    const payload = safeParse(raw);
    // Straight off an untrusted request body, so narrowed rather than stringified: an
    // attacker-supplied object would otherwise become the literal "[object Object]".
    const action = typeof payload?.action === 'string' ? payload.action : '';

    // `opened` and `synchronize` are the two that mean "there is new code to review".
    // Reviewing on every edit of the description would spend a model call on prose.
    if (action !== 'opened' && action !== 'synchronize') {
      return { received: true, action: 'ignored', reason: `pull_request.${action}` };
    }

    const job = readPullRequest(payload);
    if (!job) {
      // A payload we cannot read is not a signal to guess. Acknowledged so GitHub stops
      // retrying it, and logged so the shape can be looked at.
      this.logger.warn('pull_request payload was missing fields needed to queue a review');
      return { received: true, action: 'ignored', reason: 'unreadable payload' };
    }

    if (!this.jobs.enabled) {
      // 202 rather than 500: the delivery WAS received and verified, and retrying it will
      // not make a database appear. Saying so is more useful than a failure GitHub will
      // hammer for the next day.
      this.logger.warn('no database configured, so the review was not queued');
      return { received: true, action: 'ignored', reason: 'persistence disabled' };
    }

    const outcome = await this.jobs.enqueue({
      // GitHub reuses the delivery id across retries, which is exactly what makes it the
      // right idempotency key. Absent, fall back to the head sha so a missing header does
      // not turn every retry into a fresh review.
      deliveryId: delivery ?? `${job.owner}/${job.repo}#${job.pullNumber}@${job.headSha}`,
      ...job,
    });

    this.logger.log(
      `pull_request.${action} on ${job.owner}/${job.repo}#${job.pullNumber} — ${outcome}`,
    );
    return outcome === 'duplicate'
      ? { received: true, action: 'ignored', reason: 'duplicate delivery' }
      : { received: true, action: 'queued' };
  }
}

interface PullRequestFields {
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  baseRef: string;
  cloneUrl: string;
}

/** Reads only what a review needs, and refuses the payload if any of it is missing. */
export function readPullRequest(payload: Record<string, unknown> | null): PullRequestFields | null {
  const pull = payload?.pull_request as
    { head?: { sha?: unknown }; base?: { ref?: unknown } } | undefined;
  const repository = payload?.repository as
    { name?: unknown; clone_url?: unknown; owner?: { login?: unknown } } | undefined;

  const owner = repository?.owner?.login;
  const repo = repository?.name;
  const cloneUrl = repository?.clone_url;
  const headSha = pull?.head?.sha;
  const baseRef = pull?.base?.ref;
  const pullNumber = payload?.number;

  if (
    typeof owner !== 'string' ||
    typeof repo !== 'string' ||
    typeof cloneUrl !== 'string' ||
    typeof headSha !== 'string' ||
    typeof baseRef !== 'string' ||
    typeof pullNumber !== 'number'
  ) {
    return null;
  }

  return { owner, repo, pullNumber, headSha, baseRef, cloneUrl };
}

function safeParse(raw: Buffer): Record<string, unknown> | null {
  try {
    return JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}
