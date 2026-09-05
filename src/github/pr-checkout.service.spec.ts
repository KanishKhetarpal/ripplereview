import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CheckoutError, PrCheckoutService } from './pr-checkout.service';

/**
 * Runs against a real git repository, cloned over a real filesystem URL.
 *
 * git clone works on a local path, so the whole checkout path — clone, fetch a specific
 * commit, detached checkout, merge-base resolution — is exercised for real without a
 * network or a GitHub account. What is NOT covered here is HTTPS auth, which needs a
 * remote that demands credentials.
 */
describe('PrCheckoutService (real git)', () => {
  const service = new PrCheckoutService();

  let origin: string;
  /**
   * The origin as a file:// URL, not a bare path.
   *
   * git IGNORES --depth and --filter in a local clone — it says so in a warning — so a
   * bare path exercises neither of the flags the production clone actually uses. Over
   * file:// they apply, which is what lets the depth assertion below mean anything.
   */
  let originUrl: string;
  let headSha: string;
  let mainTipSha: string;

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  const write = (root: string, path: string, content: string): void => {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  };

  beforeAll(() => {
    origin = mkdtempSync(join(tmpdir(), 'ripplereview-origin-'));
    git(origin, 'init', '-b', 'main');
    git(origin, 'config', 'user.email', 'test@example.com');
    git(origin, 'config', 'user.name', 'Test');
    git(origin, 'config', 'commit.gpgsign', 'false');
    // A clone of a non-bare repository refuses to fetch arbitrary commits otherwise.
    git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');

    write(origin, 'src/a.ts', 'export const a = 1;\n');
    git(origin, 'add', '-A');
    git(origin, 'commit', '-m', 'base');
    const forkPoint = git(origin, 'rev-parse', 'HEAD');

    // The pull request branch.
    git(origin, 'checkout', '-q', '-b', 'feature');
    write(origin, 'src/a.ts', 'export const a = 2;\n');
    git(origin, 'add', '-A');
    git(origin, 'commit', '-m', 'feature work');
    headSha = git(origin, 'rev-parse', 'HEAD');

    // main moves on AFTER the branch was cut. This is what makes merge-base matter: the
    // review must not report this commit as part of the pull request.
    git(origin, 'checkout', '-q', 'main');
    write(origin, 'src/unrelated.ts', 'export const unrelated = true;\n');
    git(origin, 'add', '-A');
    git(origin, 'commit', '-m', 'unrelated work on main');
    mainTipSha = git(origin, 'rev-parse', 'HEAD');

    expect(forkPoint).not.toBe(mainTipSha);

    originUrl = `file:///${origin.replace(/\\/g, '/').replace(/^\//, '')}`;
  }, 120_000);

  afterAll(() => {
    rmSync(origin, { recursive: true, force: true });
  });

  /** Checkout directories currently sitting in the temp dir. */
  const temporaryCheckouts = (): string[] =>
    readdirSync(tmpdir())
      .filter((entry) => entry.startsWith('ripplereview-pr-'))
      .filter((entry) => existsSync(join(tmpdir(), entry)))
      .sort();

  it('checks out the requested head commit', async () => {
    const checkout = await service.checkout({
      cloneUrl: originUrl,
      headSha,
      baseRef: 'main',
    });

    try {
      expect(git(checkout.path, 'rev-parse', 'HEAD')).toBe(headSha);
    } finally {
      checkout.dispose();
    }
  }, 120_000);

  it('resolves the base to the MERGE BASE, not the target branch tip', async () => {
    // Diffing against the tip would report the unrelated commit that landed on main as
    // part of this pull request — findings about code the author never touched.
    const checkout = await service.checkout({
      cloneUrl: originUrl,
      headSha,
      baseRef: 'main',
    });

    try {
      expect(checkout.baseSha).not.toBe(mainTipSha);
      const changed = execFileSync('git', ['diff', '--name-only', `${checkout.baseSha}..HEAD`], {
        cwd: checkout.path,
        encoding: 'utf8',
      }).trim();

      expect(changed).toBe('src/a.ts');
      expect(changed).not.toContain('unrelated');
    } finally {
      checkout.dispose();
    }
  }, 120_000);

  it('clones deeply enough that a merge base EXISTS', async () => {
    // Measured: with --depth=1 over file://, `git merge-base HEAD FETCH_HEAD` returns
    // nothing at all — there is no common ancestor in a shallow clone — and the base
    // silently falls back to the target branch tip. Every commit that landed on the
    // target branch since the fork then reads as part of this pull request.
    const checkout = await service.checkout({ cloneUrl: originUrl, headSha, baseRef: 'main' });
    try {
      const count = Number(git(checkout.path, 'rev-list', '--count', 'HEAD'));
      expect(count).toBeGreaterThan(1);

      // The part a shallow clone actually breaks.
      const mergeBase = git(checkout.path, 'merge-base', 'HEAD', 'origin/main');
      expect(mergeBase).toMatch(/^[0-9a-f]{40}$/);
      expect(checkout.baseSha).toBe(mergeBase);
    } finally {
      checkout.dispose();
    }
  }, 120_000);

  it('removes the checkout when disposed', async () => {
    const checkout = await service.checkout({ cloneUrl: originUrl, headSha, baseRef: 'main' });
    const path = checkout.path;
    checkout.dispose();

    expect(() => execFileSync('git', ['status'], { cwd: path, stdio: 'pipe' })).toThrow();
  }, 120_000);

  it('leaves no temp directory behind when the clone fails', async () => {
    // The temp directory is created BEFORE the clone is attempted, so a failure that
    // did not clean up leaks one per failed job and eventually fills the disk of a
    // long-running worker. Asserting only that the call rejects says nothing about
    // that, and passed with the cleanup removed.
    const before = temporaryCheckouts();

    await expect(
      service.checkout({
        cloneUrl: 'file:///definitely/not/a/repository',
        headSha,
        baseRef: 'main',
      }),
    ).rejects.toBeInstanceOf(CheckoutError);

    expect(temporaryCheckouts()).toEqual(before);
  }, 120_000);

  it('fails clearly for a commit the remote does not have', async () => {
    await expect(
      service.checkout({
        cloneUrl: originUrl,
        headSha: '0000000000000000000000000000000000000000',
        baseRef: 'main',
      }),
    ).rejects.toBeInstanceOf(CheckoutError);
  }, 120_000);

  it('never puts the token in the error message', async () => {
    // The token is injected into the clone URL, and git quotes the URL back in its own
    // error text — so a failure would otherwise print the credential into a log and into
    // the job row's last_error.
    const token = 'ghs_supersecrettokenvalue';
    const error = await service
      .checkout({
        cloneUrl: 'https://github.com/no-such-owner/no-such-repo-ripplereview.git',
        headSha,
        baseRef: 'main',
        token,
      })
      .then(() => null)
      .catch((e: Error) => e);

    expect(error).toBeInstanceOf(CheckoutError);
    expect(error?.message ?? '').not.toContain(token);
  }, 180_000);
});
