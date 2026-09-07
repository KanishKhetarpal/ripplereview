import { Inject, Injectable, Logger } from '@nestjs/common';
import { Project } from 'ts-morph';
import { DuplicateMatch } from '../core/types/change-impact';
import { ChangeSet } from '../ingest/interfaces/change-set.interface';
import { EMBEDDER, Embedder } from './embedding.provider';
import { FunctionUnit, extractUnits } from './function-unit';
import { DuplicateStoreService } from './duplicate-store.service';
import { VectorIndex, overlaps } from './vector-index';

export interface DetectOptions {
  /** The project the graph engine already loaded. Never re-parsed here. */
  project: Project;
  repoRoot: string;
  /**
   * Stable identity for this repository across runs — its origin URL where it has one.
   * Only used for cross-repository matching, where a bare path would make a fresh clone
   * of the same repository look like a different one.
   */
  repoId: string;
  changeSet: ChangeSet;
}

/**
 * The similarity at which two functions are reported as the same logic.
 *
 * Measured, not chosen. Across two repositories (108 files / 1,131 functions, and 1,046
 * files / 8,000+ functions), the gap between a clone and an unrelated pair is enormous:
 * unrelated pairs sit at a median of 0.05 and a 95th percentile of 0.30-0.38, while a
 * copy-pasted function with every local renamed sits at a median of 1.00 and one with a
 * statement changed at 0.92-0.96.
 *
 * 0.85 sits in the empty space between those two populations. Raising it to 0.95 costs
 * roughly a third of the recall on realistically-edited copies (type-3 recall 66% -> 43%)
 * and buys little, because there is almost nothing between 0.85 and 0.95 to exclude.
 */
export const DUPLICATE_SIMILARITY_THRESHOLD = 0.85;

/**
 * Caps. A function copied into eight places should say so once, not eight times.
 *
 * These bound how much of a finite token budget one evidence kind can take. Without them a
 * change that touches a widely-copied helper would push the blast radius out of the
 * context entirely — trading the strongest evidence the tool has for the weakest.
 */
const MAX_MATCHES_PER_UNIT = 3;
const MAX_MATCHES_TOTAL = 10;

/**
 * Finds changed functions whose logic already exists somewhere.
 *
 * This is the one thing the dependency graph structurally cannot do. The graph answers
 * "what does this reach?"; two identical functions in unrelated modules reach nothing in
 * common and share no edge, so they are invisible to it no matter how far it walks. That
 * is why the pipeline grows a second deterministic analysis rather than a bigger graph.
 */
@Injectable()
export class DuplicateDetectorService {
  private readonly logger = new Logger(DuplicateDetectorService.name);

  constructor(
    @Inject(EMBEDDER) private readonly embedder: Embedder,
    private readonly store: DuplicateStoreService,
  ) {}

  async detect(options: DetectOptions): Promise<DuplicateMatch[]> {
    const units = extractUnits(options.project, options.repoRoot);
    const touched = units.filter((unit) => isTouched(unit, options.changeSet));

    if (touched.length === 0 || units.length < 2) return [];

    const vectors = await this.embedder.embed(units);
    const index = new VectorIndex(units.map((unit, i) => ({ unit, vector: vectors[i] })));
    const vectorById = new Map(units.map((unit, i) => [unit.id, vectors[i]]));

    const matches: DuplicateMatch[] = [];
    const seenPairs = new Set<string>();

    for (const unit of touched) {
      const query = vectorById.get(unit.id);
      if (!query) continue;

      const hits = index.search(query, {
        minSimilarity: DUPLICATE_SIMILARITY_THRESHOLD,
        limit: MAX_MATCHES_PER_UNIT,
        // Self, and any function nested inside this one or containing it: those score near
        // 1.0 because one body is literally part of the other.
        exclude: (candidate) => candidate.id === unit.id || overlaps(unit, candidate),
      });

      for (const hit of hits) {
        // When a change touches both halves of a duplicated pair, each finds the other.
        // Reporting it twice would double-charge the budget to say one thing.
        const pairKey = [unit.id, hit.unit.id].sort().join('||');
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);

        matches.push({
          unitId: unit.id,
          name: unit.name,
          file: unit.file,
          line: unit.line,
          duplicateOf: { name: hit.unit.name, file: hit.unit.file, line: hit.unit.line },
          similarity: round(hit.similarity),
          scope: 'repository',
        });
      }
    }

    matches.push(...(await this.crossRepository(options, touched, vectorById)));

    // Persisting is the last thing and never blocks a review: the corpus is a bonus, the
    // review is the product.
    await this.store.remember(options.repoId, units, vectors, this.embedder);

    return matches.sort((a, b) => b.similarity - a.similarity).slice(0, MAX_MATCHES_TOTAL);
  }

  /**
   * The same question asked of every repository reviewed before this one.
   *
   * Unreachable by the in-memory index by definition — the code is not checked out. This
   * is what the vector store is for, and it is silently skipped when no database is
   * configured or the extension is unavailable.
   */
  private async crossRepository(
    options: DetectOptions,
    touched: FunctionUnit[],
    vectorById: Map<string, Float64Array>,
  ): Promise<DuplicateMatch[]> {
    if (!this.store.available) return [];

    const matches: DuplicateMatch[] = [];

    for (const unit of touched) {
      const query = vectorById.get(unit.id);
      if (!query) continue;

      const hits = await this.store.search(query, {
        excludeRepo: options.repoId,
        embedder: this.embedder,
        minSimilarity: DUPLICATE_SIMILARITY_THRESHOLD,
        limit: MAX_MATCHES_PER_UNIT,
      });

      for (const hit of hits) {
        matches.push({
          unitId: unit.id,
          name: unit.name,
          file: unit.file,
          line: unit.line,
          duplicateOf: { name: hit.name, file: hit.file, line: hit.line, repo: hit.repo },
          similarity: round(hit.similarity),
          scope: 'other-repository',
        });
      }
    }

    if (matches.length > 0) {
      this.logger.log(`${matches.length} duplicate(s) found in previously reviewed repositories`);
    }

    return matches;
  }
}

/**
 * True when the change edited a line inside this function.
 *
 * Uses the hunks' `changedNewLines` rather than their spans, for the same reason the
 * changed-symbol resolver does: a hunk header covers up to three lines of untouched
 * context either side, so its span attributes an edit to the neighbours of the function
 * that actually changed.
 */
function isTouched(unit: FunctionUnit, changeSet: ChangeSet): boolean {
  const file = changeSet.files.find(
    (candidate) => candidate.path === unit.file && candidate.status !== 'deleted',
  );
  if (!file) return false;

  return file.hunks.some((hunk) =>
    hunk.changedNewLines.some((line) => line >= unit.line && line <= unit.endLine),
  );
}

/** Two decimal places: the difference between 0.9312 and 0.9314 is not information. */
function round(similarity: number): number {
  return Math.round(similarity * 100) / 100;
}
