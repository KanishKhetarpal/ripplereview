import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface CheckoutRequest {
  cloneUrl: string;
  headSha: string;
  baseRef: string;
  /** Injected into the clone URL for a private repository. Never logged. */
  token?: string;
}

export interface Checkout {
  path: string;
  /** The base commit the review should diff against. */
  baseSha: string;
  dispose: () => void;
}

export class CheckoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckoutError';
  }
}

/** Guards against a clone that never terminates holding a worker forever. */
const CLONE_TIMEOUT_MS = 180_000;

@Injectable()
export class PrCheckoutService {
  private readonly logger = new Logger(PrCheckoutService.name);

  /**
   * Materialises a pull request head in a temp directory.
   *
   * The graph engine reads files from disk and refuses a head ref that is not checked out,
   * so a review of a remote pull request has to start with a real working tree. There is
   * no shortcut: the analysis needs the whole repository, not the changed files.
   *
   * The clone is shallow but NOT depth-1. The reviewer diffs head against the base, so the
   * merge base has to be present; a depth-1 clone of the head has no ancestor to diff
   * against and every file reads as newly added.
   */
  async checkout(request: CheckoutRequest): Promise<Checkout> {
    const path = mkdtempSync(join(tmpdir(), 'ripplereview-pr-'));
    const dispose = (): void => rmSync(path, { recursive: true, force: true });

    try {
      await this.git(path, [
        'clone',
        '--no-tags',
        '--filter=blob:none',
        this.authenticated(request.cloneUrl, request.token),
        '.',
      ]);

      // Fetch the exact commit rather than trusting the branch tip. Between the webhook
      // firing and the worker claiming the job, the branch may have moved — and reviewing
      // a different commit than the one the review is posted against would anchor comments
      // to lines that are not there.
      await this.git(path, ['fetch', '--no-tags', 'origin', request.headSha]);
      await this.git(path, ['checkout', '--detach', request.headSha]);

      const baseSha = await this.resolveBase(path, request.baseRef);
      return { path, baseSha, dispose };
    } catch (error) {
      dispose();
      throw new CheckoutError(
        // The message may quote a git command, and the clone URL carries the token, so
        // the URL is scrubbed before this ever reaches a log or a job row.
        this.scrub(error instanceof Error ? error.message : String(error), request.token),
      );
    }
  }

  /**
   * The commit to diff against: the merge base of head and the target branch.
   *
   * Not the branch tip. If the target branch moved on after the branch was cut, diffing
   * against its tip reports everything that landed there in the meantime as part of this
   * pull request — findings about code the author never touched.
   */
  private async resolveBase(path: string, baseRef: string): Promise<string> {
    await this.git(path, ['fetch', '--no-tags', 'origin', baseRef]);

    try {
      const { stdout } = await this.git(path, ['merge-base', 'HEAD', 'FETCH_HEAD']);
      return stdout.trim();
    } catch {
      // No common ancestor is possible on an unrelated-history pull request. Falling back
      // to the fetched tip is worse than nothing would be, but it at least produces a diff.
      const { stdout } = await this.git(path, ['rev-parse', 'FETCH_HEAD']);
      this.logger.warn('no merge base found; diffing against the target branch tip instead');
      return stdout.trim();
    }
  }

  private git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return run('git', args, {
      cwd,
      timeout: CLONE_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      // Nothing this runs should ever wait on a prompt; a credential prompt inside a
      // worker is a hang, not an error.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  }

  /** Puts the token in the URL's userinfo, which is how git accepts one non-interactively. */
  private authenticated(cloneUrl: string, token?: string): string {
    if (!token) return cloneUrl;
    try {
      const url = new URL(cloneUrl);
      url.username = 'x-access-token';
      url.password = token;
      return url.toString();
    } catch {
      return cloneUrl;
    }
  }

  private scrub(message: string, token?: string): string {
    if (!token) return message;
    return message.split(token).join('***');
  }
}
