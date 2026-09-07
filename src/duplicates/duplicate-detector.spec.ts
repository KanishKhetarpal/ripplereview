import { rmSync } from 'node:fs';
import { Project } from 'ts-morph';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DuplicateMatch } from '../core/types/change-impact';
import { GitRepoService } from '../ingest/git-repo.service';
import { DuplicateDetectorService } from './duplicate-detector.service';
import { DuplicateStoreService } from './duplicate-store.service';
import { StructuralEmbedder } from './embedding.provider';
import { cosineSimilarity, fingerprint } from './code-fingerprint';
import { FunctionUnit, extractUnits } from './function-unit';
import { DuplicateFixtureRepo, buildDuplicateRepo } from './__fixtures__/build-duplicate-repo';

/**
 * The detector over a real git repository, with real ts-morph — nothing mocked.
 *
 * The fixture is built so that each assertion here corresponds to one design decision,
 * and every number was MEASURED against the fixture before it was written down. Asserting
 * only "found at least one duplicate" would pass for a detector that reports every pair of
 * functions in the repository, which is the most likely way for this to be wrong.
 */
describe('DuplicateDetectorService (real repository)', () => {
  let fixture: DuplicateFixtureRepo;
  let matches: DuplicateMatch[];
  let repoRoot: string;
  let project: Project;

  beforeAll(async () => {
    fixture = buildDuplicateRepo();
    repoRoot = fixture.path.replace(/\\/g, '/');

    project = new Project({
      tsConfigFilePath: `${repoRoot}/tsconfig.json`,
      skipFileDependencyResolution: true,
    });

    const git = new GitRepoService();
    const changeSet = await git.changeSet(fixture.path, 'HEAD~1', 'HEAD');

    // No database: the configuration a CLI run uses, and the one where cross-repository
    // matching is off but in-repository matching must still work.
    const detector = new DuplicateDetectorService(
      new StructuralEmbedder(),
      new DuplicateStoreService(null, new StructuralEmbedder()),
    );

    matches = await detector.detect({ project, repoRoot, repoId: repoRoot, changeSet });
  }, 120_000);

  afterAll(() => {
    rmSync(fixture.path, { recursive: true, force: true });
  });

  it('reports the copy-pasted function, and only it', () => {
    expect(matches).toHaveLength(1);

    const [match] = matches;
    // Direction-agnostic: BOTH halves are inside the change, so either may be the one the
    // walk reaches first. What must hold is that the pair is this pair.
    expect([match.name, match.duplicateOf.name].sort()).toEqual([
      'applyTieredDiscount',
      'reduceByBand',
    ]);
    expect([match.file, match.duplicateOf.file].sort()).toEqual([
      'src/billing/invoice.ts',
      'src/pricing/discount.ts',
    ]);
    expect(match.scope).toBe('repository');
  });

  it('scores a rename-only copy at 1.00', () => {
    // Every local name and both type names differ; the calls (`sort`, `Math.round`) do
    // not. That is exactly the shape of real copy-paste, and it normalises identically.
    expect(matches[0].similarity).toBe(1);
  });

  it('does NOT match a function with the same shape but different calls', () => {
    // `summariseBands` has the same skeleton as the discount function — build a list,
    // loop, branch, accumulate, return — and calls entirely different methods. This is the
    // case that justifies keeping call names in the token stream: with them abstracted the
    // two would be near-identical. Measured similarity with call names kept: 0.018.
    const units = extractUnits(project, repoRoot);
    const of = (name: string): FunctionUnit | undefined => units.find((unit) => unit.name === name);

    const discount = of('applyTieredDiscount');
    const summarise = of('summariseBands');
    expect(discount && summarise).toBeTruthy();

    const similarity = cosineSimilarity(
      fingerprint(discount!.tokens),
      fingerprint(summarise!.tokens),
    );
    expect(similarity).toBeLessThan(0.1);
    expect(matches.some((match) => match.name === 'summariseBands')).toBe(false);
  });

  it('does NOT report a trivial function duplicated verbatim', () => {
    // `bandRate` and `tierRate` are byte-identical. Below the size gate they are not even
    // extracted, because every one-line accessor in a codebase is identical to every other
    // and saying so on every review is noise.
    const names = extractUnits(project, repoRoot).map((unit) => unit.name);
    expect(names).not.toContain('bandRate');
    expect(names).not.toContain('tierRate');
    expect(matches.some((match) => match.name === 'bandRate')).toBe(false);
  });

  it('does NOT report a function against a closure nested inside it', () => {
    // `auditBands` is almost entirely one inline callback, so the two score 0.936 — well
    // over the threshold — purely because one body is part of the other. Without the
    // overlap exclusion this is the loudest wrong finding the tool could produce.
    const units = extractUnits(project, repoRoot);
    const outer = units.find((unit) => unit.name === 'auditBands');
    const inner = units.find((unit) => unit.name === '<anonymous>');
    expect(outer && inner).toBeTruthy();

    const similarity = cosineSimilarity(fingerprint(outer!.tokens), fingerprint(inner!.tokens));
    expect(similarity).toBeGreaterThan(0.85);
    expect(matches.some((match) => match.name === 'auditBands')).toBe(false);
  });

  it('does NOT report a duplicate the change merely sits NEXT TO', () => {
    // `settleRemainder` is a perfect 1.00 copy of `settleBalance`, and neither was edited.
    // What makes this worth a test is WHERE it lives: immediately below the function that
    // was edited, so it falls inside that hunk's three lines of trailing context. Keying
    // "did the change touch this?" off the hunk's SPAN rather than its changed lines
    // reports this pair on every review — a duplicate that has been sitting there for
    // months, blamed on whoever edited the neighbour.
    //
    // This is the same mistake the graph engine made once with hunk headers, which is why
    // it is pinned here rather than left to the reader.
    const units = extractUnits(project, repoRoot);
    const remainder = units.find((unit) => unit.name === 'settleRemainder');
    const balance = units.find((unit) => unit.name === 'settleBalance');
    expect(remainder && balance).toBeTruthy();

    // The pair really would be reported if it were considered part of the change.
    const similarity = cosineSimilarity(
      fingerprint(remainder!.tokens),
      fingerprint(balance!.tokens),
    );
    expect(similarity).toBeGreaterThan(0.99);

    const named = matches.flatMap((match) => [match.name, match.duplicateOf.name]);
    expect(named).not.toContain('settleRemainder');
    expect(named).not.toContain('settleBalance');
  });

  it('reports each duplicated pair once, not once per direction', () => {
    // The change touches both copies, so each one finds the other and the naive answer is
    // two identical findings. Asserting a set of one is only meaningful BECAUSE both sides
    // are in the change; with only one side touched this test would pass on any code.
    const touchedBothSides = matches.every((match) =>
      ['applyTieredDiscount', 'reduceByBand'].includes(match.name),
    );
    expect(touchedBothSides).toBe(true);
    expect(matches).toHaveLength(1);
  });
});
