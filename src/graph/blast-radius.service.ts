import { Injectable, Logger } from '@nestjs/common';
import { Node, Project, SyntaxKind } from 'ts-morph';
import { ImpactedSite, ModuleMetrics, SymbolId } from '../core/types/change-impact';
import { ModuleGraph } from './interfaces/module-graph.interface';
import { LocatedSymbol, MODULE_SCOPE, locateAtLine } from './symbol-locator';

export interface BlastRadiusOptions {
  maxHops: number;
  /** Absolute path of the repository root, for turning file paths into node ids. */
  repoRoot: string;
  moduleMetrics: Map<string, ModuleMetrics>;
  /** Hard ceiling on reference lookups, so a hub symbol cannot run away with the clock. */
  maxLookups?: number;
  /**
   * The module graph, used to walk dependants of a module-scope change. Optional so the
   * unit tests can exercise the symbol walk on its own.
   */
  moduleGraph?: ModuleGraph;
  /** Dependants reported per module-scope change before the rest are summarised. */
  maxModuleDependants?: number;
}

export interface BlastRadiusResult {
  sites: ImpactedSite[];
  /** How many reference lookups were performed — the dominant cost of a review. */
  lookups: number;
  /** True when the lookup ceiling stopped the walk, so the radius is a lower bound. */
  truncated: boolean;
  /**
   * Cost of the FIRST reference lookup, which pays the language service's warm-up.
   *
   * Reported apart from the rest because the two differ by orders of magnitude and are
   * fixed by different things: measured at 437ms on a 135-file repository and 18.4s on a
   * 677-file one, against ~10-100ms for every lookup afterwards. Averaged together they
   * would suggest the walk is slow, when what is slow is starting it once.
   */
  warmUpMs: number;
  /** Time in every lookup after the first. */
  lookupMs: number;
}

const DEFAULT_MAX_LOOKUPS = 400;

/**
 * A widely-imported module has enormous fan-in, and listing every dependant of an edited
 * import would drown the symbol-level evidence that is the point of this tool.
 */
const DEFAULT_MAX_MODULE_DEPENDANTS = 25;

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
    let warmUpMs = 0;
    let lookupMs = 0;

    const importers = options.moduleGraph ? buildImporterIndex(options.moduleGraph) : null;

    while (queue.length > 0) {
      const entry = queue.shift() as QueueEntry;
      if (entry.hops >= options.maxHops) continue;

      const nameNode = entry.symbol.nameNode;
      if (!nameNode) {
        // A module-scope change — an edited import, a moved top-level statement — has no
        // declaration to look references up from. It is not impact-free: everything that
        // imports the module depends on what it re-exports and on its side effects. The
        // module graph already knows who those are, so the branch continues there instead
        // of ending silently at module granularity.
        if (importers) {
          this.walkModuleDependants(entry, importers, options, seen, sites);
        }
        continue;
      }

      if (lookups >= maxLookups) {
        truncated = true;
        break;
      }
      lookups++;

      let references: Node[];
      const lookupStartedAt = Date.now();
      try {
        references = languageService.findReferencesAsNodes(nameNode);
      } catch (error) {
        // A malformed or unresolvable node is not a reason to abandon the whole walk.
        this.logger.debug(`reference lookup failed for ${entry.symbol.id}: ${String(error)}`);
        continue;
      }

      const elapsed = Date.now() - lookupStartedAt;
      if (lookups === 1) warmUpMs = elapsed;
      else lookupMs += elapsed;

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

    return { sites, lookups, truncated, warmUpMs, lookupMs };
  }

  /**
   * Breadth-first over the REVERSE module graph, from the changed module outwards.
   *
   * Reported at module granularity and labelled as such: this says "this module depends on
   * the one you changed", not "this function calls the thing you changed". Conflating the
   * two would put a weaker claim next to the symbol-level ones under the same name.
   */
  private walkModuleDependants(
    entry: QueueEntry,
    importers: Map<string, string[]>,
    options: BlastRadiusOptions,
    seen: Set<SymbolId>,
    sites: ImpactedSite[],
  ): void {
    const cap = options.maxModuleDependants ?? DEFAULT_MAX_MODULE_DEPENDANTS;
    const queue: { module: string; hops: number }[] = [
      { module: entry.symbol.file, hops: entry.hops },
    ];
    const visited = new Set<string>([entry.symbol.file]);
    let emitted = 0;

    while (queue.length > 0 && emitted < cap) {
      const current = queue.shift() as { module: string; hops: number };
      if (current.hops >= options.maxHops) continue;

      for (const importer of importers.get(current.module) ?? []) {
        if (visited.has(importer)) continue;
        visited.add(importer);

        const id = `${importer}#${MODULE_SCOPE}`;
        queue.push({ module: importer, hops: current.hops + 1 });

        if (seen.has(id)) continue;
        seen.add(id);

        sites.push({
          symbolId: id,
          file: importer,
          line: 1,
          hops: current.hops + 1,
          viaSymbolId: entry.origin,
          moduleFanIn: options.moduleMetrics.get(importer)?.fanIn ?? 0,
        });

        if (++emitted >= cap) break;
      }
    }
  }
}

/** Reverse adjacency: module -> the modules that import it. */
function buildImporterIndex(graph: ModuleGraph): Map<string, string[]> {
  const importers = new Map<string, string[]>();
  for (const edge of graph.edges) {
    importers.set(edge.to, [...(importers.get(edge.to) ?? []), edge.from]);
  }
  return importers;
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
