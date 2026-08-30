import { Injectable, Logger } from '@nestjs/common';
import { Project } from 'ts-morph';
import { ChangeKind, ChangedSymbol } from '../core/types/change-impact';
import { changedLineNumbers } from '../ingest/diff-parser';
import { ChangedFile } from '../ingest/interfaces/change-set.interface';
import { LocatedSymbol, locateAtLine } from './symbol-locator';

const ANALYSABLE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** True for a file the parser could hold an opinion about. */
export function isAnalysableSource(path: string): boolean {
  if (path.endsWith('.d.ts')) return false;
  return ANALYSABLE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

export interface ResolvedChange {
  symbols: ChangedSymbol[];
  /** Located symbols keyed by id, carrying the name node the blast radius needs. */
  located: Map<string, LocatedSymbol>;
  /** Changed files that could not be parsed — reported rather than silently skipped. */
  unparsed: string[];
}

@Injectable()
export class ChangedSymbolResolverService {
  private readonly logger = new Logger(ChangedSymbolResolverService.name);

  /**
   * Turns changed LINES into changed SYMBOLS.
   *
   * This is the step that makes the rest of the analysis possible: "lines 39-41 of
   * price.service.ts" has no blast radius, but `PriceService.total` does. Every changed
   * line is mapped to its innermost enclosing declaration and the results deduplicated, so
   * a twenty-line edit inside one method yields one changed symbol rather than twenty.
   */
  resolve(project: Project, repoRoot: string, files: ChangedFile[]): ResolvedChange {
    const located = new Map<string, LocatedSymbol>();
    const symbols: ChangedSymbol[] = [];
    const unparsed: string[] = [];

    for (const file of files) {
      if (file.status === 'deleted') {
        // The file is gone at HEAD, so there is nothing to parse and nothing that can
        // still reference its symbols without failing to compile. It stays in the change
        // set — the module graph reports the dangling edges — but contributes no symbol.
        continue;
      }

      if (!isAnalysableSource(file.path)) {
        // A README, a lockfile, a workflow: genuinely has no symbols. Reporting it as
        // unparsed would bury the case that matters — a .ts file we could not parse.
        continue;
      }

      const absolutePath = `${repoRoot}/${file.path}`;
      const sourceFile = project.getSourceFile(absolutePath);
      if (!sourceFile) {
        unparsed.push(file.path);
        continue;
      }

      const changeKind = this.changeKindFor(file.status);
      const lines =
        file.status === 'added' || file.hunks.length === 0
          ? this.allDeclarationLines(sourceFile)
          : changedLineNumbers(file);

      for (const line of lines) {
        const symbol = locateAtLine(sourceFile, file.path, line);
        if (!symbol) continue;
        if (located.has(symbol.id)) continue;

        located.set(symbol.id, symbol);
        symbols.push({
          id: symbol.id,
          name: symbol.name,
          kind: symbol.kind,
          file: symbol.file,
          line: symbol.line,
          changeKind,
          exported: symbol.exported,
        });
      }
    }

    if (unparsed.length > 0) {
      // These are source files the project did not contain — excluded by tsconfig, or
      // outside the include globs. Their symbols are missing from the analysis, so the
      // blast radius is a lower bound and someone should know.
      this.logger.warn(
        `${unparsed.length} changed source file(s) were not in the parsed project, ` +
          `so their symbols are missing: ${unparsed.join(', ')}`,
      );
    }

    return { symbols, located, unparsed };
  }

  private changeKindFor(status: ChangedFile['status']): ChangeKind {
    if (status === 'added') return 'added';
    if (status === 'deleted') return 'removed';
    return 'modified';
  }

  /**
   * Every declaration in the file.
   *
   * Used for a newly added file, where the diff's hunk covers the whole thing anyway, and
   * for a rename with no content change, where there are no hunks at all but the symbols
   * genuinely did move.
   */
  private allDeclarationLines(sourceFile: { getEndLineNumber: () => number }): number[] {
    const lines: number[] = [];
    for (let line = 1; line <= sourceFile.getEndLineNumber(); line++) {
      lines.push(line);
    }
    return lines;
  }
}
