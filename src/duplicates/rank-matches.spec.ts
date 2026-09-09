import { describe, expect, it } from 'vitest';
import { DuplicateMatch } from '../core/types/change-impact';
import { rankMatches } from './duplicate-detector.service';

/**
 * The ranking rule in isolation, with synthetic matches and a hand-built fan-in map — no
 * git, no ts-morph, so the tie-break logic is pinned independently of whether a fixture
 * repository happens to produce the right file structure. The end-to-end proof that this
 * fixes the reported crowding lives in `duplicate-detector.service.spec.ts`.
 */
function match(overrides: Partial<DuplicateMatch>): DuplicateMatch {
  return {
    unitId: 'src/a.ts#a@1',
    name: 'a',
    file: 'src/a.ts',
    line: 1,
    duplicateOf: { name: 'b', file: 'src/b.ts', line: 1 },
    similarity: 1,
    scope: 'repository',
    ...overrides,
  };
}

describe('rankMatches', () => {
  it('ranks a lower-similarity match above a higher-similarity one when it matters more', () => {
    const important = match({ file: 'src/important.ts', similarity: 0.86 });
    const trivial = match({ file: 'src/leaf.ts', similarity: 1.0 });

    const fanIn = new Map([['src/important.ts', 5]]); // src/leaf.ts absent -> 0

    const ranked = rankMatches([trivial, important], (file) => fanIn.get(file) ?? 0);

    expect(ranked[0].file).toBe('src/important.ts');
    expect(ranked[1].file).toBe('src/leaf.ts');
  });

  it('checks BOTH sides of a same-repository match, not just the changed one', () => {
    // The duplicated function might live in the important module while the CHANGE is the
    // low-importance copy — a change to a leaf file that duplicates a heavily-depended-on
    // one is exactly the case a reviewer needs told about.
    const viaDuplicateOf = match({
      file: 'src/leaf.ts',
      duplicateOf: { name: 'b', file: 'src/core.ts', line: 1 },
      similarity: 0.9,
    });
    const bothLeaves = match({ file: 'src/other-leaf.ts', similarity: 1.0 });

    const fanIn = new Map([['src/core.ts', 8]]);
    const ranked = rankMatches([bothLeaves, viaDuplicateOf], (file) => fanIn.get(file) ?? 0);

    expect(ranked[0].file).toBe('src/leaf.ts');
  });

  it('ranks a cross-repository match on the touched side only, never the other repo', () => {
    // The other repository's structure is not ours to see — there is no graph of it to
    // measure fan-in from, so pretending duplicateOf.file carries a meaningful number
    // would be inventing a fact the tool has no way to know.
    const crossRepo = match({
      file: 'src/leaf.ts',
      duplicateOf: { name: 'b', file: 'src/somewhere.ts', line: 1, repo: 'other/repo' },
      scope: 'other-repository',
      similarity: 0.9,
    });
    const inRepoImportant = match({ file: 'src/core.ts', similarity: 0.86 });

    // If duplicateOf.file leaked into the cross-repo score, this fan-in entry (which only
    // makes sense for a repository this tool never analysed) would wrongly promote it.
    const fanIn = new Map([
      ['src/core.ts', 3],
      ['src/somewhere.ts', 99],
    ]);
    const ranked = rankMatches([crossRepo, inRepoImportant], (file) => fanIn.get(file) ?? 0);

    expect(ranked[0].file).toBe('src/core.ts');
  });

  it('falls back to similarity when importance ties, which is the whole ranking with no fan-in map', () => {
    const higher = match({ file: 'src/x.ts', similarity: 0.95 });
    const lower = match({ file: 'src/y.ts', similarity: 0.9 });

    const ranked = rankMatches([lower, higher], () => 0);

    expect(ranked.map((m) => m.file)).toEqual(['src/x.ts', 'src/y.ts']);
  });

  it('does not mutate its input array', () => {
    const a = match({ file: 'src/a.ts', similarity: 0.9 });
    const b = match({ file: 'src/b.ts', similarity: 0.95 });
    const input = [a, b];

    rankMatches(input, () => 0);

    expect(input).toEqual([a, b]);
  });
});
