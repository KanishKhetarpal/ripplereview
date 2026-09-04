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
import { verifySignature } from './webhook-signature';

export interface WebhookAck {
  received: true;
  action: 'queued' | 'ignored';
  reason?: string;
}

/**
 * The GitHub webhook door.
 *
 * It verifies, acknowledges, and stops. Reviewing takes seconds to minutes — a repository
 * has to be parsed and a model called — and GitHub times a delivery out after ten seconds
 * and retries it. Doing the work inline would guarantee duplicate reviews on every large
 * change, so the endpoint records what it would run and returns.
 *
 * ⚠️ The queue itself is not built. This acknowledges and logs; the review is not
 * dispatched. Wiring it to a worker is the remaining step, and pretending otherwise by
 * kicking off a floating promise would produce exactly the duplicate-review behaviour
 * described above.
 */
@Controller('webhooks/github')
export class GitHubWebhookController {
  private readonly logger = new Logger(GitHubWebhookController.name);

  constructor(private readonly config: AppConfigService) {}

  @Post()
  @HttpCode(202)
  handle(
    @Req() request: Request,
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Headers('x-github-event') event: string | undefined,
  ): WebhookAck {
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

    const number = typeof payload?.number === 'number' ? payload.number : 0;
    const repository = payload?.repository as { full_name?: unknown } | undefined;
    const repo = typeof repository?.full_name === 'string' ? repository.full_name : '?';

    this.logger.log(`pull_request.${action} on ${repo}#${String(number)} — review not dispatched`);
    return { received: true, action: 'queued' };
  }
}

function safeParse(raw: Buffer): Record<string, unknown> | null {
  try {
    return JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}
