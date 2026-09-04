import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { PullRequestReview } from './review-comment-builder';

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly rateLimitRemaining: string | null,
  ) {
    super(`GitHub returned HTTP ${status}: ${detail}`);
    this.name = 'GitHubApiError';
  }
}

export interface PostReviewTarget {
  owner: string;
  repo: string;
  pullNumber: number;
  /** The head sha the review is anchored to. */
  commitId: string;
}

@Injectable()
export class GitHubClient {
  private readonly logger = new Logger(GitHubClient.name);

  constructor(private readonly config: AppConfigService) {}

  get configured(): boolean {
    return Boolean(this.config.githubToken);
  }

  /**
   * Posts one review: a summary body plus any inline comments.
   *
   * One request, not one per comment. GitHub renders a review as a single event, so
   * posting comments individually would produce a notification per finding and lose the
   * summary that ties them together — and would rate-limit on a large change.
   *
   * `event: 'COMMENT'` rather than REQUEST_CHANGES. Blocking a merge is a policy decision
   * that belongs to the repository, and the Action's exit code already carries it; a
   * reviewer that unilaterally blocks would be turned off within a week.
   */
  async postReview(target: PostReviewTarget, review: PullRequestReview): Promise<number> {
    const body = {
      commit_id: target.commitId,
      body: review.summary,
      event: 'COMMENT',
      comments: review.inline,
    };

    const response = await this.request(
      'POST',
      `/repos/${target.owner}/${target.repo}/pulls/${target.pullNumber}/reviews`,
      body,
    );

    const id = (response as { id?: number }).id;
    this.logger.log(
      `posted review ${String(id)} to ${target.owner}/${target.repo}#${target.pullNumber} ` +
        `(${review.inline.length} inline, ${review.offDiffCount} in summary)`,
    );
    return id ?? 0;
  }

  async getPullRequest(
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<{ headSha: string; baseSha: string }> {
    const pull = (await this.request('GET', `/repos/${owner}/${repo}/pulls/${pullNumber}`)) as {
      head?: { sha?: string };
      base?: { sha?: string };
    };

    const headSha = pull.head?.sha;
    const baseSha = pull.base?.sha;
    if (!headSha || !baseSha) {
      throw new GitHubApiError(200, 'pull request response carried no head/base sha', null);
    }
    return { headSha, baseSha };
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const token = this.config.githubToken;
    if (!token) throw new Error('GITHUB_TOKEN is not set, so nothing can be posted to GitHub');

    const response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
        'user-agent': 'ripplereview',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    const raw = await response.text();

    if (!response.ok) {
      // Verified against the live API: GitHub answers {message, documentation_url, status}
      // for both 401 and 404. The rate-limit header is carried through because "you are
      // out of quota" and "that pull request does not exist" are both 4xx and lead to
      // completely different actions.
      throw new GitHubApiError(
        response.status,
        errorDetail(raw),
        response.headers.get('x-ratelimit-remaining'),
      );
    }

    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new GitHubApiError(
        response.status,
        `response was not JSON: ${raw.slice(0, 200)}`,
        null,
      );
    }
  }
}

export function errorDetail(rawBody: string): string {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    const message = (parsed as { message?: unknown }).message;
    const errors = (parsed as { errors?: unknown }).errors;
    if (typeof message === 'string') {
      // A rejected inline comment reports why in `errors`, and that detail is the whole
      // diagnosis: it is how "the line is not part of the diff" is distinguished from a
      // bad token.
      return errors ? `${message} (${JSON.stringify(errors).slice(0, 200)})` : message;
    }
  } catch {
    // Fall through.
  }
  return rawBody.slice(0, 300) || 'no response body';
}
