import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildFixtureRepo } from '../graph/__fixtures__/build-fixture-repo';

const CLI = resolve(process.cwd(), 'dist/cli/main-cli.js');
const BUILT = existsSync(CLI);

/**
 * Spawns the compiled binary. Exit codes and stdout purity are a contract with CI and with
 * anything piping our JSON, and neither can be verified by calling a service in-process:
 * `process.exit`, Nest's `abortOnError`, and stray logger output only exist at the process
 * boundary. Every failure this file has caught so far lived exactly there.
 *
 * CI builds before it tests, so a missing `dist` there means the pipeline is about to
 * vouch for tests that never ran — that is a hard failure, not a skip.
 */
if (!BUILT && process.env.CI === 'true') {
  throw new Error(
    `dist/cli/main-cli.js is missing under CI. The CLI end-to-end tests cannot run, and ` +
      `skipping them would report a pass for behaviour nothing verified. Build before testing.`,
  );
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], env: Record<string, string> = {}): RunResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe.skipIf(!BUILT)('ripplereview CLI (spawned binary)', () => {
  it('prints its version and exits 0', () => {
    const result = run(['--version']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('0.1.0');
  });

  it('runs the demo and exits 0', () => {
    const result = run(['demo'], { LLM_PROVIDER: 'echo' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('RippleReview');
    expect(result.stdout).toContain('Blast radius');
  });

  it('emits nothing but JSON on stdout under --json', () => {
    const result = run(['--json', 'demo'], { LLM_PROVIDER: 'echo' });
    expect(result.status).toBe(0);
    const parsed: unknown = JSON.parse(result.stdout);
    expect(parsed).toHaveProperty('runId');
    expect(parsed).toHaveProperty('graphGrounded', true);
  });

  it('refuses a real repository review with exit 2 rather than inventing a result', () => {
    const result = run(['review', '.'], { LLM_PROVIDER: 'echo' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('ripplereview:');
    expect(result.stderr).toContain('Phase 1');
    expect(result.stdout).toBe('');
  });

  it('reports a bad environment as a clean message with exit 2, not a stack trace', () => {
    const result = run(['config'], { LLM_PROVIDER: 'openai', OPENAI_API_KEY: '' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('ripplereview: Invalid environment configuration');
    expect(result.stderr).toContain('OPENAI_API_KEY');
    // The failure must not arrive as an unhandled rejection from the module loader.
    expect(result.stderr).not.toContain('Module._compile');
  });

  it('reports an unimplemented provider as a clean message with exit 2', () => {
    const result = run(['demo'], { LLM_PROVIDER: 'gemini', GOOGLE_API_KEY: 'test-key' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('not implemented yet');
  });

  it('computes a real blast radius over the fixture repository', () => {
    const fixture = buildFixtureRepo();
    try {
      const result = run(['--json', 'impact', fixture.path], { LLM_PROVIDER: 'echo' });
      expect(result.status).toBe(0);

      const impact = JSON.parse(result.stdout) as {
        changedSymbols: { id: string }[];
        impactedSites: { symbolId: string; hops: number }[];
        cycles: { introducedByChange: boolean }[];
      };

      expect(impact.changedSymbols.map((s) => s.id)).toContain(
        'src/pricing/price.service.ts#PriceService.total',
      );
      expect(impact.impactedSites.map((s) => s.symbolId)).toContain(
        'src/checkout/checkout.service.ts#CheckoutService.confirm',
      );
      expect(impact.cycles.some((c) => c.introducedByChange)).toBe(true);
    } finally {
      rmSync(fixture.path, { recursive: true, force: true });
    }
  }, 120_000);

  it('refuses a head ref that is not checked out, with exit 2', () => {
    const fixture = buildFixtureRepo();
    try {
      const result = run(['impact', fixture.path, '--head', 'HEAD~1'], {
        LLM_PROVIDER: 'echo',
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('not the checked-out revision');
    } finally {
      rmSync(fixture.path, { recursive: true, force: true });
    }
  }, 120_000);

  it('rejects a nonsensical hop count instead of silently using NaN', () => {
    const result = run(['impact', '.', '--hops', 'lots'], { LLM_PROVIDER: 'echo' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('between 1 and 10');
  });

  it('prints resolved configuration as JSON', () => {
    const result = run(['config'], { LLM_PROVIDER: 'echo', BLAST_RADIUS_MAX_HOPS: '4' });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { blastRadiusMaxHops: number };
    // A number, not the string from process.env — the coercion has to survive the round trip.
    expect(parsed.blastRadiusMaxHops).toBe(4);
  });
});
