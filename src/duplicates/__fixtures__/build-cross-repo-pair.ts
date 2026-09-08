import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Two separate repositories, where the second re-implements a function from the first.
 *
 * Neither can see the other: they are different directories, different git histories, and
 * nothing is imported between them. That is the whole point — the only way to know
 * `calculateRefundShare` already exists is to have reviewed the other repository before,
 * which is what the vector store is for.
 *
 * `library` is reviewed first so its fingerprints are recorded; `service` is reviewed
 * second and should be told what it duplicated.
 */
export interface CrossRepoPair {
  library: { path: string; id: string };
  service: { path: string; id: string };
}

const TSCONFIG = JSON.stringify(
  {
    compilerOptions: { target: 'ES2022', module: 'commonjs', strict: true, skipLibCheck: true },
    include: ['src/**/*'],
  },
  null,
  2,
);

/** The function that exists in one repository and is re-implemented in the other. */
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

/** The same logic, every local renamed. Calls are identical, as in real copy-paste. */
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
  const gross = total * share;
  const settled = Math.round(gross * 100) / 100;

  return Math.max(settled, 0);
}
`;

/** Filler so neither repository is a single function, which is its own edge case. */
const FILLER = `export function summarise(values: number[]): string {
  const parts = values.map((value) => value.toFixed(1));
  const joined = parts.join(' / ');
  const trimmed = joined.trim();

  if (trimmed.length === 0) {
    return 'none';
  }

  return trimmed.toUpperCase();
}
`;

export function buildCrossRepositoryPair(): CrossRepoPair {
  const library = build('library', {
    base: { 'src/shared/proration.ts': PRORATION, 'src/shared/report.ts': FILLER },
    // A trivial edit, so the review of this repository touches something. A repository is
    // only added to the corpus when a review of it actually runs.
    head: {
      'src/shared/proration.ts': PRORATION.replace('const raw =', 'const gross =').replace(
        'raw * 100',
        'gross * 100',
      ),
    },
  });

  const service = build('service', {
    base: { 'src/plan.ts': FILLER },
    // The copy arrives. Note this repository has no proration.ts of its own, so an
    // in-repository search cannot possibly find the original.
    head: { 'src/refund.ts': REFUND },
  });

  return {
    library: { path: library, id: 'test.example/library' },
    service: { path: service, id: 'test.example/service' },
  };
}

function build(
  label: string,
  spec: { base: Record<string, string>; head: Record<string, string> },
): string {
  const path = mkdtempSync(join(tmpdir(), `ripplereview-xrepo-${label}-`));

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

  write('tsconfig.json', TSCONFIG);
  for (const [relative, content] of Object.entries(spec.base)) write(relative, content);
  git('add', '.');
  git('commit', '-m', 'base');

  for (const [relative, content] of Object.entries(spec.head)) write(relative, content);
  git('add', '-A');
  git('commit', '-m', 'head');

  return path;
}
