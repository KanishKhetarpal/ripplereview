import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Reads a fixture's `src/` directory into the same repo-relative-path -> content map
 * `RepoSpec.base` already expects, so a corpus case can vendor a real file tree instead of
 * hand-typing it. Keys are prefixed `src/...` to match `srcDir`'s own role in the repo.
 */
export function readFixtureTree(srcDir: string): Record<string, string> {
  const files: Record<string, string> = {};

  const walk = (dir: string, relativePrefix: string): void => {
    for (const entry of readdirSync(dir)) {
      const absolute = join(dir, entry);
      const relative = `${relativePrefix}${entry}`;
      if (statSync(absolute).isDirectory()) {
        walk(absolute, `${relative}/`);
        continue;
      }
      files[relative] = readFileSync(absolute, 'utf8');
    }
  };

  walk(srcDir, 'src/');
  return files;
}
