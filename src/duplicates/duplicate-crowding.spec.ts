import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DuplicateMatch } from '../core/types/change-impact';
import { BlastRadiusService } from '../graph/blast-radius.service';
import { ChangeImpactService } from '../graph/change-impact.service';
import { ChangedSymbolResolverService } from '../graph/changed-symbol-resolver.service';
import { CycleDetector } from '../graph/cycle-detector';
import { GraphMetricsService } from '../graph/graph-metrics';
import { ModuleGraphBuilderService } from '../graph/module-graph-builder.service';
import { ProjectLoaderService } from '../graph/project-loader.service';
import { GitRepoService } from '../ingest/git-repo.service';
import { NoisyRepo, buildNoisyRepo } from './__fixtures__/build-noisy-repo';
import { DuplicateDetectorService } from './duplicate-detector.service';
import { DuplicateStoreService } from './duplicate-store.service';
import { StructuralEmbedder } from './embedding.provider';

/**
 * The reported defect, reproduced and then fixed, over a real repository with real
 * ts-morph and a real module graph — nothing mocked. The unit-level ranking rule is
 * pinned separately in `rank-matches.spec.ts`; this proves the WIRING: that
 * `ChangeImpactService` and the fixture measured against it actually behave the way that
 * unit test assumes.
 *
 * The fixture holds twelve duplicate pairs and the cap keeps ten: eleven near-identical
 * pairs in files nothing imports, and one real copy-paste between two modules each
 * imported by a real caller. Similarity alone ranks the eleven above the one that matters,
 * because a pure rename scores higher than a copy with one variable folded away — which is
 * what happened for real the first time this detector ran against its own repository.
 */
describe('duplicate detection under crowding (real repository)', () => {
  let repo: NoisyRepo;
  let withoutFanIn: DuplicateMatch[];
  let withFanIn: DuplicateMatch[];

  beforeAll(async () => {
    repo = buildNoisyRepo();
    const root = repo.path.replace(/\\/g, '/');

    const git = new GitRepoService();
    const loaded = new ProjectLoaderService().load(root);
    const graphBuilder = new ModuleGraphBuilderService();
    const imports = graphBuilder.collectImports(loaded.project, loaded.files);
    const graph = graphBuilder.build(imports);
    const metrics = new GraphMetricsService().compute(graph);

    const changeSet = await git.changeSet(repo.path, 'HEAD~1', 'HEAD');
    const detector = new DuplicateDetectorService(
      new StructuralEmbedder(),
      new DuplicateStoreService(null, new StructuralEmbedder()),
    );

    withoutFanIn = await detector.detect({
      project: loaded.project,
      repoRoot: root,
      repoId: root,
      changeSet,
    });

    withFanIn = await detector.detect({
      project: loaded.project,
      repoRoot: root,
      repoId: root,
      changeSet,
      moduleFanIn: new Map([...metrics.entries()].map(([id, m]) => [id, m.fanIn])),
    });
  }, 120_000);

  afterAll(() => {
    rmSync(repo.path, { recursive: true, force: true });
  });

  const namesOf = (matches: DuplicateMatch[]): string[] =>
    matches.flatMap((match) => [match.name, match.duplicateOf.name]);

  it('reproduces the defect: WITHOUT fan-in, the important pair is crowded out', () => {
    // This is the failure this whole file exists to close. If it ever stops failing on
    // its own, the fixture has stopped modelling the defect and needs re-measuring, not
    // the assertion deleted.
    expect(namesOf(withoutFanIn)).not.toContain('calculateRefundShare');
    expect(withoutFanIn).toHaveLength(10);
  });

  it('the fix: WITH fan-in, the important pair survives the cap', () => {
    expect(namesOf(withFanIn)).toContain('calculateRefundShare');
    expect(withFanIn).toHaveLength(10);
  });

  it('makes room for it by dropping a filler pair, not by exceeding the cap', () => {
    // The cap is a token-budget guarantee elsewhere in the pipeline (evidence-builder,
    // context-assembler). A fix that raised MAX_MATCHES_TOTAL instead of re-ranking would
    // pass the two tests above and quietly break that guarantee.
    expect(withFanIn.length).toBe(withoutFanIn.length);

    const droppedNames = namesOf(withoutFanIn).filter((name) => !namesOf(withFanIn).includes(name));
    expect(droppedNames.length).toBeGreaterThan(0);
    expect(droppedNames.every((name) => name.startsWith('caseHelper'))).toBe(true);
  });

  it('reports the important pair at its real, lower similarity — not inflated to fit', () => {
    const found = withFanIn.find((match) => match.duplicateOf.name === 'prorateCharge');
    expect(found?.similarity).toBeLessThan(1);
    expect(found?.similarity).toBeGreaterThanOrEqual(0.85);
  });
});

/**
 * The wiring, not just the ranking rule: `ChangeImpactService` must actually SUPPLY the
 * fan-in map, not merely be capable of accepting one.
 *
 * Every test above calls `DuplicateDetectorService.detect()` directly with a hand-built
 * fan-in map — which proves the ranking logic works, and proves nothing about whether the
 * real pipeline ever calls it that way. It didn't: this test was written after confirming
 * that reverting `change-impact.service.ts`'s two-line wiring change left every test in
 * this file green, because none of them go through `ChangeImpactService` at all.
 */
describe('duplicate detection under crowding, through the real pipeline', () => {
  let repo: NoisyRepo;
  let duplicates: DuplicateMatch[];

  beforeAll(async () => {
    repo = buildNoisyRepo();
    const git = new GitRepoService();

    const service = new ChangeImpactService(
      new ProjectLoaderService(),
      new ModuleGraphBuilderService(),
      new CycleDetector(),
      new GraphMetricsService(),
      new ChangedSymbolResolverService(),
      new BlastRadiusService(),
      git,
      new DuplicateDetectorService(
        new StructuralEmbedder(),
        new DuplicateStoreService(null, new StructuralEmbedder()),
      ),
    );

    const changeSet = await git.changeSet(repo.path, 'HEAD~1', 'HEAD');
    const impact = await service.compute(changeSet, { repoPath: repo.path, maxHops: 3 });
    duplicates = impact.duplicates;
  }, 120_000);

  afterAll(() => {
    rmSync(repo.path, { recursive: true, force: true });
  });

  it('survives the cap when reached through ChangeImpactService, with no fan-in map built by hand', () => {
    const names = duplicates.flatMap((match) => [match.name, match.duplicateOf.name]);
    expect(names).toContain('calculateRefundShare');
    expect(duplicates).toHaveLength(10);
  });
});
