import { Injectable, Logger } from '@nestjs/common';
import { Node, Project, SyntaxKind } from 'ts-morph';
import { ImpactedSite, ModuleMetrics, SymbolId } from '../core/types/change-impact';
import { LocatedSymbol, MODULE_SCOPE, locateAtLine } from './symbol-locator';

export interface BlastRadiusOptions {
  maxHops: number;
  /** Absolute path of the repository root, for turning file paths into node ids. */
  repoRoot: string;
  moduleMetrics: Map<string, ModuleMetrics>;
  /** Hard ceiling on reference lookups, so a hub symbol cannot run away with the clock. */
  maxLookups?: number;
}

export interface BlastRadiusResult {
  sites: ImpactedSite[];
  /** How many reference lookups were performed — the dominant cost of a review. */
  lookups: number;
  /** True when the lookup ceiling stopped the walk, so the radius is a lower bound. */
  truncated: boolean;
}

const DEFAULT_MAX_LOOKUPS = 400;

interface QueueEntry {
  symbol: LocatedSymbol;
  hops: number;
  /** The changed symbol this branch of the walk started from. */
  origin: SymbolId;
}

@Injectable()
export class BlastRadiusService {
  private readonly logger = new Logger(BlastRadiusService.name);

  /**
   * Walks outwards from each changed symbol to the modules and declarations that reach it.
   *
   * Breadth-first, so a site is recorded at the SHORTEST distance from a changed symbol —
   * which is what makes hop count usable for ranking in the context assembler. A site found
   * again further out is not re-recorded.
   *
   * The expensive part is `findReferencesAsNodes`. Measured: the first call pays the
   * language service's warm-up (0.4s on a 135-file repo, 18s on a 677-file one), and every
   * call after it costs ~10-100ms. So the cost of a review is roughly one warm-up plus the
   * number of lookups, which is why that number is capped and reported.
   */
  compute(
    project: Project,
    changed: LocatedSymbol[],
    options: BlastRadiusOptions,
  ): BlastRadiusResult {
    const maxLookups = options.maxLookups ?? DEFAULT_MAX_LOOKUPS;
    const languageService = project.getLanguageService();

    const sites: ImpactedSite[] = [];
    const seen = new Set<SymbolId>(changed.map((symbol) => symbol.id));
    const queue: QueueEntry[] = changed.map((symbol) => ({
      symbol,
      hops: 0,
      origin: symbol.id,
    }));

    let lookups = 0;
    let truncated = false;

    while (queue.length > 0) {
      const entry = queue.shift() as QueueEntry;
      if (entry.hops >= options.maxHops) continue;

      const nameNode = entry.symbol.nameNode;
      if (!nameNode) continue;

      if (lookups >= maxLookups) {
        truncated = true;
        break;
      }
      lookups++;

      let references: Node[];
      try {
        references = languageService.findReferencesAsNodes(nameNode);
      } catch (error) {
        // A malformed or unresolvable node is not a reason to abandon the whole walk.
        this.logger.debug(`reference lookup failed for ${entry.symbol.id}: ${String(error)}`);
        continue;
      }

      for (const reference of references) {
        if (isDeclarationSite(reference, nameNode)) continue;
        if (isImportOrExportSpecifier(reference)) continue;

        const referenceFile = reference.getSourceFile();
        const relativePath = toRelative(referenceFile.getFilePath(), options.repoRoot);
        if (!relativePath) continue;

        const site = locateAtLine(referenceFile, relativePath, reference.getStartLineNumber());
        if (!site) continue;
        if (seen.has(site.id)) continue;
        seen.add(site.id);

        sites.push({
          symbolId: site.id,
          file: site.file,
          line: reference.getStartLineNumber(),
          hops: entry.hops + 1,
          viaSymbolId: entry.origin,
          moduleFanIn: options.moduleMetrics.get(relativePath)?.fanIn ?? 0,
        });

        // Module scope has no name node, so the walk cannot continue through it — that is
        // the honest end of that branch, not a silent one.
        if (site.name !== MODULE_SCOPE) {
          queue.push({ symbol: site, hops: entry.hops + 1, origin: entry.origin });
        }
      }
    }

    if (truncated) {
      this.logger.warn(
        `blast radius stopped at the ${maxLookups}-lookup ceiling; the result is a lower bound`,
      );
    }

    return { sites, lookups, truncated };
  }
}

/**
 * The declaration's own name is always in its own reference set. Counting it would make
 * every changed symbol impact itself at hop 1.
 */
function isDeclarationSite(reference: Node, nameNode: Node): boolean {
  return (
    reference === nameNode ||
    (reference.getSourceFile() === nameNode.getSourceFile() &&
      reference.getStart() === nameNode.getStart())
  );
}

/**
 * An `import { total } from './pricing'` line is a reference to `total`, and it is not a
 * call site.
 *
 * Probed directly: a symbol used through a barrel file comes back with BOTH the import
 * statement and the actual use, in every importing file. Left in, every module that merely
 * imports a changed symbol becomes an impacted site — and worse, the import sits at module
 * scope, so the whole file would be reported as impacted at hop 1 whether or not anything
 * in it uses the symbol.
 */
function isImportOrExportSpecifier(reference: Node): boolean {
  return (
    reference.getFirstAncestorByKind(SyntaxKind.ImportDeclaration) !== undefined ||
    reference.getFirstAncestorByKind(SyntaxKind.ExportDeclaration) !== undefined
  );
}

function toRelative(absolutePath: string, repoRoot: string): string | null {
  const normalisedRoot = repoRoot.replace(/\\/g, '/').replace(/\/$/, '');
  const normalised = absolutePath.replace(/\\/g, '/');
  if (!normalised.startsWith(`${normalisedRoot}/`)) return null;
  return normalised.slice(normalisedRoot.length + 1);
}
