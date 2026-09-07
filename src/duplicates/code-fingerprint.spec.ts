import { describe, expect, it } from 'vitest';
import {
  FINGERPRINT_DIMENSIONS,
  SHINGLE_SIZE,
  cosineSimilarity,
  fingerprint,
} from './code-fingerprint';

const tokens = (count: number, seed = 'A'): string[] =>
  Array.from({ length: count }, (_, i) => `${seed}${i % 17}`);

describe('fingerprint', () => {
  it('is deterministic', () => {
    // The property that lets a duplicate be called ground truth. A fingerprint that
    // depended on iteration order or on a random seed would make the same review report
    // different structure on different machines.
    expect(Array.from(fingerprint(tokens(50)))).toEqual(Array.from(fingerprint(tokens(50))));
  });

  it('produces a unit vector of the declared width', () => {
    const vector = fingerprint(tokens(50));
    expect(vector.length).toBe(FINGERPRINT_DIMENSIONS);

    const norm = Math.sqrt(Array.from(vector).reduce((sum, value) => sum + value * value, 0));
    expect(norm).toBeCloseTo(1, 10);
  });

  it('scores identical token streams at exactly 1', () => {
    expect(cosineSimilarity(fingerprint(tokens(60)), fingerprint(tokens(60)))).toBeCloseTo(1, 10);
  });

  it('scores unrelated token streams near 0', () => {
    const similarity = cosineSimilarity(fingerprint(tokens(60, 'A')), fingerprint(tokens(60, 'Z')));
    expect(Math.abs(similarity)).toBeLessThan(0.2);
  });

  it('gives a token stream shorter than one shingle a zero vector, not NaN', () => {
    // No windows means no features. Normalising a zero vector would divide by zero and
    // every later comparison would be NaN — which compares false against a threshold, so
    // the failure would look exactly like "no duplicates found".
    const vector = fingerprint(tokens(SHINGLE_SIZE - 1));

    expect(Array.from(vector).every((value) => value === 0)).toBe(true);
    expect(cosineSimilarity(vector, fingerprint(tokens(60)))).toBe(0);
  });

  it('refuses to compare vectors of different widths', () => {
    // Returning a number here would silently compare a prefix, which is how a store
    // holding vectors from two embedders would produce plausible nonsense.
    expect(() => cosineSimilarity(new Float64Array(8), new Float64Array(16))).toThrow(
      /different widths|8-dimension|16-dimension/,
    );
  });

  it('separates a one-token edit from an unrelated stream', () => {
    // A realistic type-3 clone: one statement changed. It must stay far closer to the
    // original than an unrelated function is, or the threshold has nothing to sit between.
    const original = tokens(80);
    const edited = [...original];
    edited[40] = 'DIFFERENT';

    const nearby = cosineSimilarity(fingerprint(original), fingerprint(edited));
    const distant = cosineSimilarity(fingerprint(original), fingerprint(tokens(80, 'Z')));

    expect(nearby).toBeGreaterThan(0.85);
    expect(nearby).toBeGreaterThan(distant + 0.5);
  });
});
