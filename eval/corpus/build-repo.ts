import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface RepoSpec {
  /** Files at the base commit. */
  base: Record<string, string>;
  /** Files written on top for the head commit. A null value deletes the file. */
  head: Record<string, string | null>;
}

const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2022',
      module: 'commonjs',
      strict: true,
      skipLibCheck: true,
      noEmit: true,
    },
    include: ['src/**/*'],
  },
  null,
  2,
);

/**
 * Builds a two-commit repository in a temp directory.
 *
 * Every corpus case is a real git repository with a real base and head, because the thing
 * under test ingests git. A synthetic diff string would let the harness pass while the
 * ingest layer was broken.
 */
export function buildRepo(spec: RepoSpec): { path: string } {
  const path = mkdtempSync(join(tmpdir(), 'ripplereview-eval-'));

  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: path, encoding: 'utf8', stdio: 'pipe' });
  };

  const write = (relative: string, content: string): void => {
    const absolute = join(path, relative);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  };

  git('init', '-b', 'main');
  git('config', 'user.email', 'eval@example.com');
  git('config', 'user.name', 'Eval');
  git('config', 'commit.gpgsign', 'false');

  write('tsconfig.json', TSCONFIG);
  for (const [relative, content] of Object.entries(spec.base)) {
    write(relative, content);
  }
  git('add', '.');
  git('commit', '-m', 'base');

  for (const [relative, content] of Object.entries(spec.head)) {
    if (content === null) {
      rmSync(join(path, relative), { force: true });
      continue;
    }
    write(relative, content);
  }
  git('add', '-A');
  git('commit', '-m', 'head');

  return { path };
}
