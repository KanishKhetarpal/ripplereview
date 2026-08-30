import { posix } from 'node:path';

const RESOLVABLE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * Expands a relative import specifier written from `importerRelativePath` into the ordered
 * list of repo-relative paths it could resolve to — extension-less, explicit extensions,
 * then directory index files — mirroring Node/TS resolution without touching the disk.
 *
 * Adapted from arch-lens. Extended with the .mts/.cts/.mjs/.cjs forms, and with the
 * TypeScript rule that an import written `./x.js` may resolve to `./x.ts`: under
 * NodeNext, source that will be emitted as ESM must spell the specifier with the emitted
 * extension, so a graph that only tried `.js` would miss every edge in such a project.
 */
export function candidateSpecifierPaths(importerRelativePath: string, specifier: string): string[] {
  const importerDir = posix.dirname(importerRelativePath);
  const joined = posix.normalize(posix.join(importerDir, specifier));

  const candidates = [joined];

  for (const ext of RESOLVABLE_EXTENSIONS) {
    candidates.push(`${joined}${ext}`);
  }

  const rewritten = joined.replace(/\.(js|jsx|mjs|cjs)$/, '');
  if (rewritten !== joined) {
    for (const ext of ['.ts', '.tsx', '.mts', '.cts']) {
      candidates.push(`${rewritten}${ext}`);
    }
  }

  for (const ext of RESOLVABLE_EXTENSIONS) {
    candidates.push(posix.join(joined, `index${ext}`));
  }

  return candidates;
}

/** True for a specifier that names a package rather than a file in this repository. */
export function isExternalSpecifier(specifier: string): boolean {
  return !specifier.startsWith('.');
}

/**
 * Resolves a relative specifier to the repo-relative path it points at, or undefined when
 * it falls outside the parsed set — a file that was ignored, or one that does not exist.
 */
export function resolveModuleSpecifier(
  importerRelativePath: string,
  specifier: string,
  knownRelativePaths: ReadonlySet<string>,
): string | undefined {
  return candidateSpecifierPaths(importerRelativePath, specifier).find((candidate) =>
    knownRelativePaths.has(candidate),
  );
}
