import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * A repository built to pin every decision the duplicate detector makes.
 *
 * At base there is one substantial function, `applyTieredDiscount`, and one trivial one,
 * `tierRate`. HEAD adds a billing module containing four functions, each of which exists
 * to force a different answer out of the detector:
 *
 *   reduceByBand    a real copy-paste of applyTieredDiscount with every local renamed.
 *                   MUST be reported. This is the whole feature.
 *   summariseBands  the same SHAPE — loop, branch, accumulate, return — calling entirely
 *                   different methods. MUST NOT be reported: it is the case that decides
 *                   whether keeping call names in the token stream was worth its cost.
 *   bandRate        a byte-identical twin of the trivial tierRate. MUST NOT be reported:
 *                   below the size gate, where "duplication" is not a defect.
 *   auditBands      a function that is almost entirely one large inline callback. MUST NOT
 *                   be reported against its own closure, which scores near 1.0 because one
 *                   body is literally part of the other.
 */
export interface DuplicateFixtureRepo {
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

const BASE_FILES: Record<string, string> = {
  'tsconfig.json': TSCONFIG,

  // `settleBalance` is a renamed copy of `settleRemainder`, and NEITHER file is edited at
  // head. Both exist so that "did the change touch this function?" can be got wrong in a
  // way that is otherwise invisible: `settleRemainder` sits inside the CONTEXT LINES of the
  // hunk that edits the function above it, so a detector keying off the hunk's span rather
  // than its changed lines treats it as touched and reports this pair.
  'src/ledger/settlement.ts': `export function settleBalance(amount: number, deltas: number[]): number {
  const usable = deltas.filter((delta) => delta > 0);
  let running = amount;

  for (const delta of usable) {
    if (running > delta) {
      running = running - delta;
      continue;
    }
  }

  return Math.max(running, 0);
}
`,

  'src/pricing/discount.ts': `export interface Tier {
  threshold: number;
  rate: number;
}

export function applyTieredDiscount(amount: number, tiers: Tier[]): number {
  const sorted = [...tiers].sort((left, right) => right.threshold - left.threshold);
  let result = amount;

  for (const tier of sorted) {
    if (amount >= tier.threshold) {
      result = amount - amount * tier.rate;
      break;
    }
  }

  return Math.round(result * 100) / 100;
}

export function settleRemainder(balance: number, steps: number[]): number {
  const positive = steps.filter((step) => step > 0);
  let carried = balance;

  for (const step of positive) {
    if (carried > step) {
      carried = carried - step;
      continue;
    }
  }

  return Math.max(carried, 0);
}

export function tierRate(tier: Tier): number {
  return tier.rate;
}
`,
};

const HEAD_FILES: Record<string, string> = {
  // The original, with two locals renamed and nothing else.
  //
  // This puts BOTH halves of the duplicated pair inside the change, so each one finds the
  // other and the pair must still be reported once rather than twice. It also exercises
  // rename-invariance end to end: the tokens are identical to base, so the copy still
  // scores exactly 1.00 rather than merely close to it.
  'src/pricing/discount.ts': `export interface Tier {
  threshold: number;
  rate: number;
}

export function applyTieredDiscount(amount: number, tiers: Tier[]): number {
  const ordered = [...tiers].sort((left, right) => right.threshold - left.threshold);
  let outcome = amount;

  for (const tier of ordered) {
    if (amount >= tier.threshold) {
      outcome = amount - amount * tier.rate;
      break;
    }
  }

  return Math.round(outcome * 100) / 100;
}

export function settleRemainder(balance: number, steps: number[]): number {
  const positive = steps.filter((step) => step > 0);
  let carried = balance;

  for (const step of positive) {
    if (carried > step) {
      carried = carried - step;
      continue;
    }
  }

  return Math.max(carried, 0);
}

export function tierRate(tier: Tier): number {
  return tier.rate;
}
`,

  'src/billing/invoice.ts': `export interface Band {
  threshold: number;
  rate: number;
}

export function reduceByBand(total: number, bands: Band[]): number {
  const ordered = [...bands].sort((first, second) => second.threshold - first.threshold);
  let outcome = total;

  for (const band of ordered) {
    if (total >= band.threshold) {
      outcome = total - total * band.rate;
      break;
    }
  }

  return Math.round(outcome * 100) / 100;
}

export function summariseBands(bands: Band[]): string {
  const labels = bands.map((band) => band.threshold.toFixed(2));
  let text = '';

  for (const label of labels) {
    if (label.length > 0) {
      text = text.concat(label, '; ');
      continue;
    }
  }

  return text.trim().toUpperCase();
}

export function bandRate(band: Band): number {
  return band.rate;
}

export function auditBands(bands: Band[]): string[] {
  return bands.map((band) => {
    const threshold = band.threshold.toFixed(2);
    const rate = (band.rate * 100).toFixed(1);
    const label = threshold.padStart(10, ' ');

    if (band.rate > 0.5) {
      return label.concat(' HIGH ', rate);
    }

    return label.concat(' ok ', rate);
  });
}
`,
};

export function buildDuplicateRepo(): DuplicateFixtureRepo {
  const path = mkdtempSync(join(tmpdir(), 'ripplereview-dup-'));

  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: path, encoding: 'utf8' });

  const write = (relative: string, content: string): void => {
    const absolute = join(path, relative);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  };

  git('init', '-b', 'main');
  git('config', 'user.email', 'fixture@example.com');
  git('config', 'user.name', 'Fixture');
  git('config', 'commit.gpgsign', 'false');

  for (const [relative, content] of Object.entries(BASE_FILES)) write(relative, content);
  git('add', '.');
  git('commit', '-m', 'base');

  for (const [relative, content] of Object.entries(HEAD_FILES)) write(relative, content);
  git('add', '-A');
  git('commit', '-m', 'head');

  return { path };
}
