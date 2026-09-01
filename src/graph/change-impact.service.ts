import { Injectable, Logger } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Node, Project } from 'ts-morph';
import {
  ChangeImpact,
  CycleImpact,
  InstabilityDelta,
  LayerViolation,
  ModuleMetrics,
} from '../core/types/change-impact';
import { GitRepoService } from '../ingest/git-repo.service';
import { ChangeSet } from '../ingest/interfaces/change-set.interface';
import { ArchitectureRule, edgeKey, findViolations, parseRules } from './architecture-rules';
import { BlastRadiusService } from './blast-radius.service';
import { ChangedSymbolResolverService } from './changed-symbol-resolver.service';
import { CycleDetector, componentKey } from './cycle-detector';
import { GraphMetricsService } from './graph-metrics';
import { ModuleGraph, ModuleImports } from './interfaces/module-graph.interface';
import { ModuleGraphBuilderService } from './module-graph-builder.service';
import { ProjectLoaderService } from './project-loader.service';

export const RULES_FILENAME = '.ripplereview.rules';

export interface ComputeImpactOptions {
  repoPath: string;
  maxHops: number;
}

/**
 * The impact plus the working material behind it.
 *
 * The context assembler needs the loaded project and the changed declarations to quote the
 * type definitions the change refers to. Re-loading the project there would cost a second
 * parse of the whole repository — measured at 741ms and 160MB on a 677-file repo — to
 * rebuild something this service is already holding.
 */
export interface ImpactAnalysis {
  impact: ChangeImpact;
  project: Project;
  changedDeclarations: Node[];
}

@Injectable()
export class ChangeImpactService {
  private readonly logger = new Logger(ChangeImpactService.name);

  constructor(
    private readonly loader: ProjectLoaderService,
    private readonly moduleGraphs: ModuleGraphBuilderService,
    private readonly cycles: CycleDetector,
    private readonly metrics: GraphMetricsService,
    private readonly changedSymbols: ChangedSymbolResolverService,
    private readonly blastRadius: BlastRadiusService,
    private readonly git: GitRepoService,
  ) {}

  /** Convenience for callers that only want the facts. */
  async compute(changeSet: ChangeSet, options: ComputeImpactOptions): Promise<ChangeImpact> {
    return (await this.analyse(changeSet, options)).impact;
  }

  async analyse(changeSet: ChangeSet, options: ComputeImpactOptions): Promise<ImpactAnalysis> {
    const startedAt = Date.now();
    const repoRoot = resolve(options.repoPath).replace(/\\/g, '/');

    const loaded = this.loader.load(repoRoot);
    const headImports = this.moduleGraphs.collectImports(loaded.project, loaded.files);
    const headGraph = this.moduleGraphs.build(headImports);
    const headMetrics = this.metrics.compute(headGraph);

    const baseGraph = await this.buildBaseGraph(repoRoot, changeSet, headImports);
    const baseMetrics = this.metrics.compute(baseGraph);

    const resolved = this.changedSymbols.resolve(loaded.project, repoRoot, changeSet.files);
    const radius = this.blastRadius.compute(loaded.project, [...resolved.located.values()], {
      maxHops: options.maxHops,
      repoRoot,
      moduleMetrics: headMetrics,
      moduleGraph: headGraph,
    });

    const rules = this.loadRules(repoRoot);
    const baseEdges = new Set(baseGraph.edges.map(edgeKey));

    const impact: ChangeImpact = {
      repo: { root: repoRoot, baseRef: changeSet.baseRef, headRef: changeSet.headRef },
      changedFiles: changeSet.files.map((file) => file.path),
      changedSymbols: resolved.symbols,
      impactedSites: radius.sites,
      cycles: this.compareCycles(baseGraph, headGraph),
      layerViolations: this.violations(headGraph, rules, baseEdges),
      instabilityDeltas: this.instabilityDeltas(changeSet, headMetrics, baseMetrics),
      unanalysedFiles: resolved.unparsed,
      stats: {
        hopLimit: options.maxHops,
        warmUpMs: radius.warmUpMs,
        lookupMs: radius.lookupMs,
        lookups: radius.lookups,
        moduleCount: headGraph.nodes.length,
        edgeCount: headGraph.edges.length,
        impactedSiteCount: radius.sites.length,
        durationMs: Date.now() - startedAt,
      },
    };

    const changedDeclarations = [...resolved.located.values()]
      .map((symbol) => symbol.declaration)
      .filter((node): node is Node => node !== undefined);

    return { impact, project: loaded.project, changedDeclarations };
  }

  /**
   * The module graph as it stood at the base ref.
   *
   * Built by adjusting the head graph rather than loading the base revision, and that is a
   * measured decision. A resolving load of a 677-file repository cost 25s and 2.2GB; even
   * the cheap loader is ~750ms and ~160MB, and cycle comparison needs BOTH revisions in
   * memory at once. Checking out a second worktree costs disk and mutates the user's .git.
   *
   * The adjustment is exact for this purpose. A file that did not change has identical
   * imports at both refs, so only the changed files need their base content fetched —
   * typically under twenty `git show` calls instead of one for every file in the repo.
   * Added files are removed from the base node set, deleted files are restored to it.
   */
  private async buildBaseGraph(
    repoRoot: string,
    changeSet: ChangeSet,
    headImports: ModuleImports[],
  ): Promise<ModuleGraph> {
    const byPath = new Map(headImports.map((entry) => [entry.relativePath, entry]));
    const scratch = new Project({ useInMemoryFileSystem: true });

    for (const file of changeSet.files) {
      const basePath = file.previousPath ?? file.path;

      if (file.status === 'added') {
        byPath.delete(file.path);
        continue;
      }

      if (file.status === 'renamed') {
        byPath.delete(file.path);
      }

      const content = await this.git.fileAtRef(repoRoot, changeSet.baseRef, basePath);
      if (content === null) {
        byPath.delete(basePath);
        continue;
      }

      const parsed = scratch.createSourceFile(`/base/${basePath}`, content, { overwrite: true });
      byPath.set(basePath, {
        relativePath: basePath,
        specifiers: this.moduleGraphs.extractSpecifiers(parsed),
      });
    }

    return this.moduleGraphs.build([...byPath.values()]);
  }

  /**
   * Cycles present at head, each flagged with whether the change created it.
   *
   * A pre-existing cycle is still worth reporting — a change inside one is riskier than the
   * diff suggests — but "you introduced this" and "you touched code inside this" are very
   * different claims, and only the first should be blamed on the author.
   */
  private compareCycles(baseGraph: ModuleGraph, headGraph: ModuleGraph): CycleImpact[] {
    const baseKeys = new Set(this.cycles.findCycles(baseGraph).map(componentKey));

    return this.cycles.findCycles(headGraph).map((component) => ({
      nodeIds: [...component.nodeIds].sort(),
      introducedByChange: !baseKeys.has(componentKey(component)),
    }));
  }

  private violations(
    graph: ModuleGraph,
    rules: ArchitectureRule[],
    baseEdges: ReadonlySet<string>,
  ): LayerViolation[] {
    if (rules.length === 0) return [];
    return findViolations(graph, rules, baseEdges);
  }

  /**
   * Instability change for the modules the diff actually touched.
   *
   * Reporting it for every module would bury the signal: a change anywhere shifts the ratio
   * of everything it imports, and none of that is the reviewer's business.
   */
  private instabilityDeltas(
    changeSet: ChangeSet,
    head: Map<string, ModuleMetrics>,
    base: Map<string, ModuleMetrics>,
  ): InstabilityDelta[] {
    const deltas: InstabilityDelta[] = [];

    for (const file of changeSet.files) {
      const after = head.get(file.path);
      if (!after) continue;
      deltas.push({
        module: file.path,
        before: base.get(file.previousPath ?? file.path) ?? null,
        after,
      });
    }

    return deltas;
  }

  private loadRules(repoRoot: string): ArchitectureRule[] {
    const path = join(repoRoot, RULES_FILENAME);
    if (!existsSync(path)) return [];

    const rules = parseRules(readFileSync(path, 'utf8'));
    this.logger.debug(`loaded ${rules.length} architecture rule(s) from ${RULES_FILENAME}`);
    return rules;
  }
}
