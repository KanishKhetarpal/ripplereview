import { posix } from 'node:path';

const RESOLVABLE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];

/**
 * Expands a relative import specifier written from `importerRelativePath`
 * into the ordered list of repo-relative paths it could resolve to
 * (extension-less, explicit extensions, then directory index files) —
 * mirroring Node/TS module resolution without touching the filesystem.
 */
export function candidateSpecifierPaths(importerRelativePath: string, specifier: string): string[] {
  const importerDir = posix.dirname(importerRelativePath);
  const joined = posix.normalize(posix.join(importerDir, specifier));

  const candidates = [joined];
  for (const ext of RESOLVABLE_EXTENSIONS) {
    candidates.push(`${joined}${ext}`);
  }
  for (const ext of RESOLVABLE_EXTENSIONS) {
    candidates.push(posix.join(joined, `index${ext}`));
  }
  return candidates;
}

/**
 * Resolves a relative import specifier to the `relativePath` of the
 * ModuleSymbol it points at, or undefined if it falls outside the parsed
 * set (e.g. it resolves to a file that wasn't ingested).
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
