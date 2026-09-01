import { Injectable } from '@nestjs/common';
import { ChangeImpact, ImpactedSite } from '../core/types/change-impact';
import { MODULE_SCOPE } from '../graph/symbol-locator';

const ESC = '\u001b';

const ANSI: Record<string, string> = {
  reset: `${ESC}[0m`,
  bold: `${ESC}[1m`,
  dim: `${ESC}[2m`,
  red: `${ESC}[31m`,
  yellow: `${ESC}[33m`,
  green: `${ESC}[32m`,
};

export interface ImpactRenderOptions {
  color: boolean;
  /** Impacted sites listed per changed symbol before the rest are summarised. */
  maxSitesPerSymbol?: number;
}

const DEFAULT_MAX_SITES = 8;

@Injectable()
export class ImpactRenderer {
  renderJson(impact: ChangeImpact): string {
    return JSON.stringify(impact, null, 2);
  }

  /**
   * The blast radius as a person reads it.
   *
   * Grouped by the changed symbol each site traces back to, rather than as one flat list:
   * "these 14 places depend on the thing you changed" is a fact about a specific symbol,
   * and a flat list of 14 makes the reader reconstruct that grouping themselves.
   */
  renderText(impact: ChangeImpact, options: ImpactRenderOptions): string {
    const paint = (name: string, text: string): string =>
      options.color ? `${ANSI[name]}${text}${ANSI.reset}` : text;
    const limit = options.maxSitesPerSymbol ?? DEFAULT_MAX_SITES;

    const lines: string[] = [];
    lines.push(paint('bold', 'RippleReview — change impact'));
    lines.push(paint('dim', `${impact.repo.baseRef}..${impact.repo.headRef}  ${impact.repo.root}`));
    lines.push(
      paint(
        'dim',
        `${impact.stats.moduleCount} modules, ${impact.stats.edgeCount} edges  |  ` +
          `${impact.stats.hopLimit} hop limit  |  ${impact.stats.durationMs}ms ` +
          `(${impact.stats.lookups} lookups: ${impact.stats.warmUpMs}ms warm-up + ` +
          `${impact.stats.lookupMs}ms)`,
      ),
    );
    lines.push('');

    if (impact.unanalysedFiles.length > 0) {
      lines.push(
        paint(
          'yellow',
          `${impact.unanalysedFiles.length} changed source file(s) were not in the parsed ` +
            'project, so their symbols are missing and the blast radius below is a lower bound:',
        ),
      );
      for (const file of impact.unanalysedFiles.slice(0, 5)) {
        lines.push(`  ${paint('dim', file)}`);
      }
      lines.push('');
    }

    lines.push(...this.renderChangedSymbols(impact, paint, limit));
    lines.push(...this.renderCycles(impact, paint));
    lines.push(...this.renderViolations(impact, paint));
    lines.push(...this.renderInstability(impact, paint));

    return lines.join('\n');
  }

  private renderChangedSymbols(
    impact: ChangeImpact,
    paint: (name: string, text: string) => string,
    limit: number,
  ): string[] {
    const lines: string[] = [];

    if (impact.changedSymbols.length === 0) {
      lines.push(paint('dim', 'No changed symbols resolved.'));
      lines.push('');
      return lines;
    }

    lines.push(
      paint(
        'bold',
        `Changed symbols (${impact.changedSymbols.length}) and what they reach ` +
          `(${impact.impactedSites.length} site${impact.impactedSites.length === 1 ? '' : 's'})`,
      ),
    );
    lines.push('');

    const byOrigin = new Map<string, ImpactedSite[]>();
    for (const site of impact.impactedSites) {
      byOrigin.set(site.viaSymbolId, [...(byOrigin.get(site.viaSymbolId) ?? []), site]);
    }

    for (const symbol of impact.changedSymbols) {
      const marker = symbol.exported ? '' : paint('dim', ' (module-private)');
      lines.push(`  ${paint('bold', symbol.name)}${marker}`);
      lines.push(
        `    ${paint('dim', `${symbol.file}:${symbol.line}  ${symbol.kind}  ${symbol.changeKind}`)}`,
      );

      const sites = (byOrigin.get(symbol.id) ?? []).sort((a, b) => a.hops - b.hops);
      if (sites.length === 0 && symbol.name === MODULE_SCOPE) {
        // A module-scope change (an edited import, a moved top-level statement) has no
        // declaration to look references up from, so its dependents are not walked at all.
        // Reporting that as "nothing was impacted" would be a claim we did not check.
        lines.push(
          `    ${paint('yellow', 'module-level change — dependents not walked (module granularity only)')}`,
        );
      } else if (sites.length === 0) {
        // Not the same as "nothing depends on it": a caller that ALSO changed is a
        // changed symbol in its own right, not something this change impacted.
        lines.push(`    ${paint('dim', 'no impacted sites outside the change itself')}`);
      } else {
        for (const site of sites.slice(0, limit)) {
          lines.push(
            `    ${paint('dim', `${site.hops} hop`)}  ${site.file}:${site.line}  ` +
              `${paint('dim', shortName(site.symbolId))}`,
          );
        }
        if (sites.length > limit) {
          lines.push(`    ${paint('dim', `... and ${sites.length - limit} more`)}`);
        }
      }
      lines.push('');
    }

    return lines;
  }

  private renderCycles(
    impact: ChangeImpact,
    paint: (name: string, text: string) => string,
  ): string[] {
    if (impact.cycles.length === 0) return [];

    const lines: string[] = [paint('bold', `Circular dependencies (${impact.cycles.length})`)];
    for (const cycle of impact.cycles) {
      const label = cycle.introducedByChange
        ? paint('red', 'INTRODUCED')
        : paint('dim', 'pre-existing');
      lines.push(`  ${label}  ${cycle.nodeIds.join(' <-> ')}`);
    }
    lines.push('');
    return lines;
  }

  private renderViolations(
    impact: ChangeImpact,
    paint: (name: string, text: string) => string,
  ): string[] {
    if (impact.layerViolations.length === 0) return [];

    const lines: string[] = [
      paint('bold', `Architecture violations (${impact.layerViolations.length})`),
    ];
    for (const violation of impact.layerViolations) {
      const label = violation.introducedByChange
        ? paint('red', 'INTRODUCED')
        : paint('dim', 'pre-existing');
      lines.push(`  ${label}  ${violation.fromModule} -> ${violation.toModule}`);
      lines.push(`    ${paint('dim', violation.rule)}`);
    }
    lines.push('');
    return lines;
  }

  private renderInstability(
    impact: ChangeImpact,
    paint: (name: string, text: string) => string,
  ): string[] {
    const moved = impact.instabilityDeltas.filter(
      (delta) => delta.before === null || delta.before.instability !== delta.after.instability,
    );
    if (moved.length === 0) return [];

    const lines: string[] = [paint('bold', `Instability changes (${moved.length})`)];
    for (const delta of moved) {
      const before = delta.before ? delta.before.instability.toFixed(2) : 'new';
      const after = delta.after.instability.toFixed(2);
      const rising = delta.before !== null && delta.after.instability > delta.before.instability;
      lines.push(
        `  ${delta.module}  ${paint(rising ? 'yellow' : 'green', `${before} -> ${after}`)}  ` +
          `${paint('dim', `fan-in ${delta.after.fanIn}, fan-out ${delta.after.fanOut}`)}`,
      );
    }
    lines.push('');
    return lines;
  }
}

/** `src/a/b.ts#Class.method` reads better as `Class.method` once the path is already shown. */
function shortName(symbolId: string): string {
  const hash = symbolId.indexOf('#');
  return hash === -1 ? symbolId : symbolId.slice(hash + 1);
}
