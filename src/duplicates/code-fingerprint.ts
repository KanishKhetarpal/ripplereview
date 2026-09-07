import { createHash } from 'node:crypto';

/**
 * A function's logic reduced to a fixed-length unit vector.
 *
 * The vector is the interface on purpose: a deterministic structural fingerprint and a
 * neural embedding both produce one, cosine similarity is the same operation over either,
 * and pgvector stores either. That is what lets the default be offline and free while
 * leaving a real seam for an embedding model.
 */

/**
 * Shingle width, in tokens.
 *
 * Measured across k = 3, 5 and 7 on two repositories. k=3 lets unrelated pairs run hot
 * (median 0.20 against 0.05 at k=5). k=7 separates best but is the most brittle to an
 * edit: recall on a clone with one statement changed falls from 0.94 to 0.89 median,
 * and a clone with one statement changed is the common real case. k=5 is the balance.
 */
export const SHINGLE_SIZE = 5;

/**
 * Feature-hashing width.
 *
 * 256 and 512 were measured and are indistinguishable on separation (unrelated-pair p95
 * 0.286 either way), so the smaller wins: it is half the storage and half the work per
 * comparison, and a 256-wide brute-force scan of 1,235 functions costs 61ms for 100
 * queries — cheap enough that no index is needed at repository scale.
 */
export const FINGERPRINT_DIMENSIONS = 256;

/**
 * Bumped whenever the tokeniser or the hashing changes.
 *
 * Stored fingerprints from an older version are NOT comparable with new ones — the same
 * function would land somewhere else in the space — so persisted vectors are filtered on
 * it rather than silently mixed. Without this, changing the tokeniser would not break
 * anything visibly; it would just quietly stop finding duplicates.
 */
export const FINGERPRINT_VERSION = 1;

/**
 * Hashes overlapping token windows into a signed, L2-normalised vector.
 *
 * Feature hashing rather than a learned projection because it needs no training data, no
 * vocabulary and no model file, and it is exactly reproducible on any machine — which is
 * the requirement that matters here, since a duplicate is a structural claim and the
 * project's central rule is that structural claims must be reproducible.
 *
 * The sign trick (half the buckets counted negative) is what keeps unrelated functions
 * near zero instead of near a positive constant: without it every vector shares the same
 * non-negative orthant and collisions can only ever inflate similarity.
 */
export function fingerprint(tokens: string[]): Float64Array {
  const vector = new Float64Array(FINGERPRINT_DIMENSIONS);
  const windows = tokens.length - SHINGLE_SIZE + 1;

  for (let i = 0; i < windows; i++) {
    const digest = createHash('sha1')
      .update(tokens.slice(i, i + SHINGLE_SIZE).join(' '))
      .digest();

    vector[digest.readUInt32BE(0) % FINGERPRINT_DIMENSIONS] += digest[4] & 1 ? 1 : -1;
  }

  return normalise(vector);
}

/**
 * Scales to unit length, so cosine similarity is a plain dot product.
 *
 * A function with fewer than SHINGLE_SIZE tokens produces no windows and stays all-zero.
 * That is returned as-is rather than treated as an error: its similarity with everything
 * is 0, which is the correct answer for a body with no structure to compare.
 */
function normalise(vector: Float64Array): Float64Array {
  let sumOfSquares = 0;
  for (const value of vector) sumOfSquares += value * value;

  const norm = Math.sqrt(sumOfSquares);
  if (norm === 0) return vector;

  for (let i = 0; i < vector.length; i++) vector[i] /= norm;
  return vector;
}

/** Both operands are unit vectors, so this is cosine similarity in [-1, 1]. */
export function cosineSimilarity(a: Float64Array, b: Float64Array): number {
  if (a.length !== b.length) {
    throw new Error(
      `cannot compare a ${a.length}-dimension vector with a ${b.length}-dimension one`,
    );
  }

  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}
