import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * A repository shaped like the one that found the defect this fixture exists to pin.
 *
 * The first time the detector ran for real, all ten reported matches were duplicated test
 * fixtures — real duplicates, ranked to the top purely because a copy-pasted spec file
 * scores as high as a copy-pasted service. Here that is manufactured on purpose: **eleven**
 * near-identical pairs living in files nothing imports (module fan-in 0, standing in for
 * `__fixtures__`/`*.spec.ts` without hard-coding a path pattern this fixture would then be
 * the only thing testing), plus **one** pair that is the whole point — the same
 * proration-share logic copy-pasted between billing and refunds, each half imported by a
 * real caller, so each half has real fan-in.
 *
 * Eleven low-importance pairs is one more than `MAX_MATCHES_TOTAL` (10), so similarity
 * alone crowds the important pair out of the report entirely; fan-in-aware ranking is what
 * gets it back in.
 */
export interface NoisyRepo {
  path: string;
}

const TSCONFIG = JSON.stringify(
  {
    compilerOptions: { target: 'ES2022', module: 'commonjs', strict: true, skipLibCheck: true },
    include: ['src/**/*'],
  },
  null,
  2,
);

/** Eleven distinct near-identical pairs, so no filler pair matches a different filler pair. */
const FILLER_COUNT = 11;

/**
 * A distinct helper name PER INDEX, called inside the loop. Call targets are the one
 * thing the token normaliser keeps verbatim (`function-unit.ts`'s `normaliseTokens`), so
 * this is what stops case 3 matching case 7 as well as matching its own twin — without it
 * every filler collapses into one giant mutually-matching cluster and the fixture no
 * longer isolates "eleven pairs" from "eleven pairs plus every cross-pair combination".
 */
function fillerPair(index: number): {
  left: string;
  right: string;
  leftFile: string;
  rightFile: string;
} {
  const marker = `markCase${index}`;
  const leftFile = `src/scratch/case${index}/left.ts`;
  const rightFile = `src/scratch/case${index}/right.ts`;

  const body = (
    fnName: string,
    paramName: string,
  ): string => `function ${marker}(entry: number): number {
  return entry;
}

export function ${fnName}(${paramName}: number[]): number {
  const positive = ${paramName}.filter((entry) => entry > 0);
  let running = 0;

  for (const entry of positive) {
    running = running + ${marker}(entry);
  }

  return Math.max(running, 0);
}
`;

  return {
    left: body(`caseHelper${index}`, 'values'),
    right: body(`caseHelperCopy${index}`, 'items'),
    leftFile,
    rightFile,
  };
}

/** The important pair: real copy-paste, each half imported by a real caller. */
const PRORATION = `export function prorateCharge(
  amount: number,
  daysUsed: number,
  daysInPeriod: number,
): number {
  if (daysInPeriod <= 0) {
    return 0;
  }

  const capped = Math.min(Math.max(daysUsed, 0), daysInPeriod);
  const ratio = capped / daysInPeriod;
  const raw = amount * ratio;
  const rounded = Math.round(raw * 100) / 100;

  return Math.max(rounded, 0);
}
`;

/**
 * A REALISTIC copy, not a pure rename: one intermediate variable folded away. Exact
 * renames score 1.00; this scores lower — still comfortably over the 0.85 threshold, but
 * BELOW where the filler pairs sit. That gap is deliberate: it is what makes the
 * "WITHOUT fan-in" run below lose this pair to similarity alone, rather than the outcome
 * depending on an incidental tie-break in stable sort order.
 */
const REFUND = `export function calculateRefundShare(
  total: number,
  unusedDays: number,
  cycleLength: number,
): number {
  if (cycleLength <= 0) {
    return 0;
  }

  const bounded = Math.min(Math.max(unusedDays, 0), cycleLength);
  const share = bounded / cycleLength;
  const settled = Math.round(total * share * 100) / 100;

  return Math.max(settled, 0);
}
`;

export function buildNoisyRepo(): NoisyRepo {
  const path = mkdtempSync(join(tmpdir(), 'ripplereview-noisy-'));

  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: path, encoding: 'utf8', stdio: 'pipe' });
  };

  const write = (relative: string, content: string): void => {
    const absolute = join(path, relative);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  };

  git('init', '-b', 'main');
  git('config', 'user.email', 'fixture@example.com');
  git('config', 'user.name', 'Fixture');
  git('config', 'commit.gpgsign', 'false');

  // Base: just the important pair's originals, each unimported — the change below is what
  // gives them fan-in, by adding the callers alongside the copies.
  write('tsconfig.json', TSCONFIG);
  write('src/billing/proration.ts', PRORATION);
  git('add', '.');
  git('commit', '-m', 'base');

  // Head: the copy-paste, plus a real caller for each half, plus eleven filler pairs — all
  // new files, so every function in this commit is "touched" by construction.
  write('src/subscriptions/refund.ts', REFUND);
  write(
    'src/billing/invoice.ts',
    `import { prorateCharge } from './proration';

export function invoiceLine(amount: number, daysUsed: number, daysInPeriod: number): string {
  return 'due: ' + prorateCharge(amount, daysUsed, daysInPeriod).toFixed(2);
}
`,
  );
  write(
    'src/subscriptions/plan.ts',
    `import { calculateRefundShare } from './refund';

export function planRefund(monthlyPrice: number, unusedDays: number): number {
  return calculateRefundShare(monthlyPrice, unusedDays, 30);
}
`,
  );

  for (let i = 0; i < FILLER_COUNT; i++) {
    const filler = fillerPair(i);
    write(filler.leftFile, filler.left);
    write(filler.rightFile, filler.right);
  }

  git('add', '-A');
  git('commit', '-m', 'head');

  return { path };
}
