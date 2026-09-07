import { cosineSimilarity } from './code-fingerprint';
import { FunctionUnit } from './function-unit';

export interface IndexedUnit {
  unit: FunctionUnit;
  vector: Float64Array;
}

export interface SimilarityHit {
  unit: FunctionUnit;
  similarity: number;
}

export interface SearchOptions {
  minSimilarity: number;
  limit: number;
  /** Hits are rejected when this returns true. Used to drop self and nested matches. */
  exclude?: (candidate: FunctionUnit) => boolean;
}

/**
 * Brute-force nearest-neighbour search over one repository's functions.
 *
 * No ANN index, and that is measured rather than lazy: 100 queries against 1,235 vectors
 * of 256 dimensions took 61ms. A repository would need to be two orders of magnitude
 * larger before an index paid for its own build time, and an approximate index would trade
 * exactness for that — on a claim that is supposed to be exact.
 *
 * The pgvector store is where an index becomes worthwhile, because there the corpus spans
 * every repository ever reviewed rather than the one in front of us.
 */
export class VectorIndex {
  constructor(private readonly entries: IndexedUnit[]) {}

  get size(): number {
    return this.entries.length;
  }

  search(query: Float64Array, options: SearchOptions): SimilarityHit[] {
    const hits: SimilarityHit[] = [];

    for (const entry of this.entries) {
      if (options.exclude?.(entry.unit)) continue;

      const similarity = cosineSimilarity(query, entry.vector);
      if (similarity < options.minSimilarity) continue;

      hits.push({ unit: entry.unit, similarity });
    }

    return hits.sort((a, b) => b.similarity - a.similarity).slice(0, options.limit);
  }
}

/**
 * True when two units occupy overlapping lines of the same file.
 *
 * The exclusion that stops a function matching a closure nested inside it. Those score
 * near 1.0 by construction — the inner function's tokens are a subset of the outer's — and
 * reporting "this function duplicates its own callback" would be the loudest and most
 * obviously wrong finding the tool could produce. Found in the probe output before it
 * could reach anyone: `buildMonthlyTrend` at line 114 "duplicating" the arrow function at
 * line 119, similarity 0.996.
 */
export function overlaps(a: FunctionUnit, b: FunctionUnit): boolean {
  return a.file === b.file && a.line <= b.endLine && b.line <= a.endLine;
}
