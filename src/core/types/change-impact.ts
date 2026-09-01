/**
 * Everything in this file is GROUND TRUTH: produced by deterministic static analysis
 * over the dependency graph, never by the language model. The reviewer is allowed to
 * reason about these facts; it is never allowed to invent them.
 *
 * Populated by the graph engine in Phase 1.
 */

export type SymbolKind =
  'function' | 'class' | 'method' | 'variable' | 'interface' | 'type' | 'enum' | 'unknown';

export type ChangeKind = 'added' | 'modified' | 'removed';

/** A stable, human-readable symbol id: `src/orders/order.service.ts#OrderService.total`. */
export type SymbolId = string;

export interface ChangedSymbol {
  id: SymbolId;
  name: string;
  kind: SymbolKind;
  /** Repo-relative POSIX path. */
  file: string;
  line: number;
  changeKind: ChangeKind;
  /** True when the symbol is reachable from outside its own module. */
  exported: boolean;
}

/** A place that transitively depends on a changed symbol — the blast radius. */
export interface ImpactedSite {
  symbolId: SymbolId;
  file: string;
  line: number;
  /** Hop distance from the changed symbol. 1 = direct caller. */
  hops: number;
  /** Which changed symbol this site traces back to. */
  viaSymbolId: SymbolId;
  /** Fan-in of the module holding this site, used to rank what makes the context budget. */
  moduleFanIn: number;
}

export interface CycleImpact {
  /** Module ids (repo-relative paths) forming the strongly connected component. */
  nodeIds: string[];
  /** True only when the SCC is absent from the base graph and present in the head graph. */
  introducedByChange: boolean;
}

export interface LayerViolation {
  /** The rule that was broken, quoted from the architecture config. */
  rule: string;
  fromModule: string;
  toModule: string;
  /** The import specifier as written in source. */
  specifier: string;
  /** True when this edge does not exist in the base graph. */
  introducedByChange: boolean;
}

export interface ModuleMetrics {
  fanIn: number;
  fanOut: number;
  /** Martin's instability: fanOut / (fanIn + fanOut). 0 = stable, 1 = unstable. */
  instability: number;
}

export interface InstabilityDelta {
  module: string;
  /** Null when the module is new in the head revision. */
  before: ModuleMetrics | null;
  after: ModuleMetrics;
}

export interface ImpactStats {
  hopLimit: number;
  /** First reference lookup, which pays the language service's one-time warm-up. */
  warmUpMs: number;
  /** Every reference lookup after the first, summed. */
  lookupMs: number;
  /** How many reference lookups the blast-radius walk performed. */
  lookups: number;
  moduleCount: number;
  edgeCount: number;
  /** Sites found before the hop cap and any ranking cut. */
  impactedSiteCount: number;
  durationMs: number;
}

export interface ChangeImpact {
  repo: {
    /** Absolute path of the working tree that was analysed. */
    root: string;
    baseRef: string;
    headRef: string;
  };
  changedFiles: string[];
  changedSymbols: ChangedSymbol[];
  impactedSites: ImpactedSite[];
  cycles: CycleImpact[];
  layerViolations: LayerViolation[];
  instabilityDeltas: InstabilityDelta[];
  /**
   * Source files the change touched that the parsed project did not contain — excluded by
   * the repository's tsconfig, or outside its include globs.
   *
   * Their symbols are missing from the analysis, so the blast radius is a lower bound.
   * Carried on the result rather than only logged: a reviewer reading a thin report needs
   * to be able to tell "nothing depends on this" from "we could not see the files that do".
   */
  unanalysedFiles: string[];
  stats: ImpactStats;
}
