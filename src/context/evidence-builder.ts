import { Injectable } from '@nestjs/common';
import { ChangeImpact, DuplicateMatch, ImpactedSite } from '../core/types/change-impact';
import { EvidenceItem } from '../core/types/evidence';

/**
 * Ranking weights. Higher survives when the budget is tight.
 *
 * The ordering is a claim about what a reviewer cannot work out for themselves. A cycle
 * the change just created, and an architecture rule it just broke, are facts about the
 * change that no amount of reading the diff would reveal — they rank above everything. A
 * pre-existing cycle is context, not a finding, so it ranks below a direct caller.
 */
const WEIGHTS = {
  introducedCycle: 1000,
  introducedViolation: 950,
  /** A direct caller at hop 1; each further hop costs 100. */
  impactedSiteBase: 800,
  perHopPenalty: 100,
  existingViolation: 300,
  existingCycle: 250,
  instabilityDelta: 200,
  typeDefinition: 400,
  /**
   * Duplicate logic, before the similarity bonus below.
   *
   * The band 685-700 that this produces sits deliberately between a direct caller (800+)
   * and a two-hop dependant (600-650). A function that already exists somewhere is worth
   * more than a distant transitive dependant — nobody can find it by reading — and less
   * than something the change is about to break outright.
   */
  duplicateLogic: 600,
} as const;

@Injectable()
export class EvidenceBuilder {
  /**
   * Turns ground truth into citable lines.
   *
   * Ids are assigned in rank order (`E1` is the most important fact), so a prompt truncated
   * anywhere still reads sensibly, and a reader scanning citations sees the strongest
   * evidence first. Every summary is one line, because the model has to be able to use it
   * without opening anything.
   */
  build(impact: ChangeImpact): EvidenceItem[] {
    const items: Omit<EvidenceItem, 'id'>[] = [
      ...this.cycleEvidence(impact),
      ...this.violationEvidence(impact),
      ...this.blastRadiusEvidence(impact),
      ...this.instabilityEvidence(impact),
      ...this.duplicateEvidence(impact),
    ];

    return items
      .sort((a, b) => b.weight - a.weight)
      .map((item, index) => ({ ...item, id: `E${index + 1}` }));
  }

  private cycleEvidence(impact: ChangeImpact): Omit<EvidenceItem, 'id'>[] {
    return impact.cycles.map((cycle) => ({
      kind: 'cycle' as const,
      summary: cycle.introducedByChange
        ? `This change INTRODUCES a circular dependency: ${cycle.nodeIds.join(' -> ')} -> ${cycle.nodeIds[0]}`
        : `Pre-existing circular dependency (not introduced here): ${cycle.nodeIds.join(' -> ')}`,
      weight: cycle.introducedByChange ? WEIGHTS.introducedCycle : WEIGHTS.existingCycle,
      location: { file: cycle.nodeIds[0] },
    }));
  }

  private violationEvidence(impact: ChangeImpact): Omit<EvidenceItem, 'id'>[] {
    return impact.layerViolations.map((violation) => ({
      kind: 'layer-violation' as const,
      summary:
        `${violation.introducedByChange ? 'This change INTRODUCES' : 'Pre-existing'} ` +
        `architecture violation: ${violation.fromModule} imports ${violation.toModule}, ` +
        `forbidden by "${violation.rule}"`,
      weight: violation.introducedByChange
        ? WEIGHTS.introducedViolation
        : WEIGHTS.existingViolation,
      location: { file: violation.fromModule },
    }));
  }

  /**
   * Impacted sites, ranked by hop distance first and module fan-in second.
   *
   * Hop distance dominates because a direct caller is what breaks first. Fan-in breaks the
   * tie: among two equally distant call sites, the one in a module that half the codebase
   * depends on is the one worth spending budget on.
   */
  private blastRadiusEvidence(impact: ChangeImpact): Omit<EvidenceItem, 'id'>[] {
    const changedById = new Map(impact.changedSymbols.map((symbol) => [symbol.id, symbol]));

    return [...impact.impactedSites].sort(bySiteImportance).map((site) => {
      const via = changedById.get(site.viaSymbolId);
      const viaName = via ? via.name : site.viaSymbolId;
      return {
        kind: 'blast-radius' as const,
        summary:
          `${shortName(site.symbolId)} at ${site.file}:${site.line} depends on the changed ` +
          `${viaName} (${site.hops} hop${site.hops === 1 ? '' : 's'} away, module fan-in ${site.moduleFanIn})`,
        weight: Math.max(
          1,
          WEIGHTS.impactedSiteBase -
            site.hops * WEIGHTS.perHopPenalty +
            Math.min(site.moduleFanIn, 50),
        ),
        location: { file: site.file, line: site.line },
      };
    });
  }

  /**
   * Only modules whose instability actually moved.
   *
   * Reporting the metric for every touched module would spend budget restating numbers that
   * did not change, which tells the reviewer nothing about this change.
   */
  private instabilityEvidence(impact: ChangeImpact): Omit<EvidenceItem, 'id'>[] {
    return impact.instabilityDeltas
      .filter(
        (delta) => delta.before === null || delta.before.instability !== delta.after.instability,
      )
      .map((delta) => ({
        kind: 'instability' as const,
        summary: delta.before
          ? `${delta.module} instability ${delta.before.instability.toFixed(2)} -> ` +
            `${delta.after.instability.toFixed(2)} (fan-in ${delta.after.fanIn}, fan-out ${delta.after.fanOut})`
          : `${delta.module} is new (fan-in ${delta.after.fanIn}, fan-out ${delta.after.fanOut})`,
        weight: WEIGHTS.instabilityDelta,
        location: { file: delta.module },
      }));
  }

  /**
   * Functions the change touched whose logic already exists somewhere else.
   *
   * The one evidence kind the dependency graph structurally cannot produce: two identical
   * functions in unrelated modules share no edge, so no amount of graph walking reaches
   * one from the other.
   *
   * The similarity is stated rather than converted to a word. "0.92 similar" tells a
   * reader how much to trust it; "duplicated" asserts a judgement the tool has not made —
   * the two copies may have diverged deliberately.
   */
  private duplicateEvidence(impact: ChangeImpact): Omit<EvidenceItem, 'id'>[] {
    return impact.duplicates.map((match) => ({
      kind: 'duplicate' as const,
      summary: describeDuplicate(match),
      // A closer match outranks a looser one, so when the budget is tight the item that
      // survives is the one most likely to be a real copy rather than a coincidence.
      weight: WEIGHTS.duplicateLogic + Math.round(match.similarity * 100),
      location: { file: match.file, line: match.line },
    }));
  }
}

/** One line, in the same shape as every other evidence summary. */
function describeDuplicate(match: DuplicateMatch): string {
  const where =
    match.scope === 'other-repository'
      ? `${match.duplicateOf.file}:${match.duplicateOf.line} in ${match.duplicateOf.repo ?? 'another reviewed repository'}`
      : `${match.duplicateOf.file}:${match.duplicateOf.line}`;

  return (
    `${match.name} at ${match.file}:${match.line} is ${match.similarity.toFixed(2)} similar to ` +
    `the existing ${match.duplicateOf.name} at ${where} ` +
    '(structural comparison: local names and literal values are abstracted, calls are not)'
  );
}

/**
 * Nearest first, then by how much depends on the module holding the site.
 *
 * A module function rather than a method: passing a method reference to `.sort` detaches
 * it from its instance, which works only for as long as the comparator happens not to
 * touch `this`.
 */
function bySiteImportance(a: ImpactedSite, b: ImpactedSite): number {
  if (a.hops !== b.hops) return a.hops - b.hops;
  return b.moduleFanIn - a.moduleFanIn;
}

/** A type or interface definition the changed and impacted code refers to. */
export function typeDefinitionEvidence(
  name: string,
  file: string,
  line: number,
  source: string,
): Omit<EvidenceItem, 'id'> {
  return {
    kind: 'type-definition',
    summary: `Definition of ${name} (${file}:${line})`,
    detail: source,
    weight: WEIGHTS.typeDefinition,
    location: { file, line },
  };
}

export function shortName(symbolId: string): string {
  const hash = symbolId.indexOf('#');
  return hash === -1 ? symbolId : symbolId.slice(hash + 1);
}

export { WEIGHTS as EVIDENCE_WEIGHTS };
