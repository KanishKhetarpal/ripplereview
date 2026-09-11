import { rmSync } from 'node:fs';
import { DiagnosticCategory, Project, ts } from 'ts-morph';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChangeImpact } from '../../src/core/types/change-impact';
import { BlastRadiusService } from '../../src/graph/blast-radius.service';
import { ChangeImpactService } from '../../src/graph/change-impact.service';
import { ChangedSymbolResolverService } from '../../src/graph/changed-symbol-resolver.service';
import { CycleDetector } from '../../src/graph/cycle-detector';
import { GraphMetricsService } from '../../src/graph/graph-metrics';
import { ModuleGraphBuilderService } from '../../src/graph/module-graph-builder.service';
import { ProjectLoaderService } from '../../src/graph/project-loader.service';
import { DuplicateDetectorService } from '../../src/duplicates/duplicate-detector.service';
import { DuplicateStoreService } from '../../src/duplicates/duplicate-store.service';
import { StructuralEmbedder } from '../../src/duplicates/embedding.provider';
import { GitRepoService } from '../../src/ingest/git-repo.service';
import { CROSS_MODULE_KINDS } from '../metrics';
import { CORPUS, caseByName } from './index';

/**
 * Validates the corpus itself, before any of it is used to score a model.
 *
 * Two things have to be true or the measurement is meaningless rather than merely noisy.
 *
 * The repositories must COMPILE at head. A defect that also breaks the build would be
 * caught by tsc long before a reviewer saw it, so measuring whether a model spots it says
 * nothing about reviewing.
 *
 * The graph engine must actually SURFACE each structural defect. If the cycle is not
 * detected, the grounded arm has no more information than the baseline and a tie proves
 * nothing about context — it proves the corpus was broken. That is a far easier mistake to
 * make than it looks, and it is invisible in the final numbers.
 */
describe('eval corpus', () => {
  const git = new GitRepoService();
  const impacts = new ChangeImpactService(
    new ProjectLoaderService(),
    new ModuleGraphBuilderService(),
    new CycleDetector(),
    new GraphMetricsService(),
    new ChangedSymbolResolverService(),
    new BlastRadiusService(),
    git,
    // A real detector with no database behind it: duplicate detection inside the
    // repository under review needs none, and that is the configuration a CLI run uses.
    new DuplicateDetectorService(
      new StructuralEmbedder(),
      new DuplicateStoreService(null, new StructuralEmbedder()),
    ),
  );

  const built = new Map<string, { path: string; impact: ChangeImpact }>();

  beforeAll(async () => {
    for (const entry of CORPUS) {
      const repo = entry.build();
      const changeSet = await git.changeSet(repo.path, 'HEAD~1', 'HEAD');
      const impact = await impacts.compute(changeSet, { repoPath: repo.path, maxHops: 3 });
      built.set(entry.name, { path: repo.path, impact });
    }
  }, 300_000);

  afterAll(() => {
    for (const { path } of built.values()) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  describe('every case', () => {
    for (const entry of CORPUS) {
      it(`${entry.name}: compiles at head`, () => {
        const { path } = built.get(entry.name)!;
        const project = new Project({ tsConfigFilePath: `${path}/tsconfig.json` });
        const errors = project
          .getPreEmitDiagnostics()
          .filter((d) => d.getCategory() === DiagnosticCategory.Error);

        // Flattened, not String()'d: a diagnostic message can be a nested chain object,
        // and stringifying it gives "[object Object]" — useless in exactly the moment the
        // assertion fires and someone needs to know what broke.
        expect(
          errors.map(
            (d) =>
              `${d.getSourceFile()?.getBaseName() ?? '?'}: ` +
              ts.flattenDiagnosticMessageText(d.compilerObject.messageText, ' '),
          ),
        ).toEqual([]);
      }, 120_000);

      it(`${entry.name}: the change is non-empty`, () => {
        const { impact } = built.get(entry.name)!;
        expect(impact.changedFiles.length).toBeGreaterThan(0);
      });

      it(`${entry.name}: nothing went unanalysed`, () => {
        // A source file the project did not contain would silently shrink the blast
        // radius, and the grounded arm would be handicapped by a corpus bug.
        const { impact } = built.get(entry.name)!;
        expect(impact.unanalysedFiles).toEqual([]);
      });

      it(`${entry.name}: every declared defect names a file the change touched`, () => {
        const { impact } = built.get(entry.name)!;
        for (const defect of entry.defects) {
          const known = [...impact.changedFiles, ...impact.impactedSites.map((s) => s.file)];
          expect(known).toContain(defect.file);
        }
      });
    }
  });

  describe('the graph engine surfaces each structural defect', () => {
    it('signature-drift: the un-updated caller is in the blast radius', () => {
      const { impact } = built.get('signature-drift')!;

      expect(impact.changedSymbols.map((s) => s.id)).toContain(
        'src/pricing/price.service.ts#PriceService.total',
      );
      // This is the whole point of the case: the invoice builder is never mentioned in the
      // diff, and the graph is the only thing that can put it in front of the reviewer.
      expect(impact.impactedSites.map((s) => s.file)).toContain(
        'src/invoicing/invoice.builder.ts',
      );
    });

    it('signature-drift: the diff really does not mention the un-updated caller', () => {
      // If it did, the baseline could see it too and the case would measure nothing.
      const { impact } = built.get('signature-drift')!;
      expect(impact.changedFiles).not.toContain('src/invoicing/invoice.builder.ts');
    });

    it('new-cycle: the cycle is detected AND attributed to this change', () => {
      const { impact } = built.get('new-cycle')!;
      const introduced = impact.cycles.filter((cycle) => cycle.introducedByChange);

      expect(introduced).toHaveLength(1);
      expect(introduced[0].nodeIds.sort()).toEqual([
        'src/audit/audit.log.ts',
        'src/session/session.store.ts',
      ]);
    });

    it('layering-breach: the violation is detected AND attributed to this change', () => {
      const { impact } = built.get('layering-breach')!;
      const introduced = impact.layerViolations.filter((v) => v.introducedByChange);

      expect(introduced).toHaveLength(1);
      expect(introduced[0].fromModule).toBe('src/domain/order.ts');
      expect(introduced[0].toModule).toBe('src/infrastructure/database.ts');
    });

    it('local-bug: the graph offers NO structural evidence, which is the point', () => {
      // The control only controls if the grounded arm genuinely has no extra structural
      // information here. Otherwise a win on this case would be unattributable.
      const { impact } = built.get('local-bug')!;
      expect(impact.cycles.filter((c) => c.introducedByChange)).toEqual([]);
      expect(impact.layerViolations).toEqual([]);
    });

    it('duplicate-logic: the detector surfaces the copy, at full similarity', () => {
      const { impact } = built.get('duplicate-logic')!;

      expect(impact.duplicates).toHaveLength(1);
      const [match] = impact.duplicates;
      expect(match.name).toBe('calculateRefundShare');
      expect(match.file).toBe('src/subscriptions/refund.ts');
      expect(match.duplicateOf.name).toBe('prorateCharge');
      expect(match.duplicateOf.file).toBe('src/billing/proration.ts');
      expect(match.similarity).toBe(1);
    });

    it('duplicate-logic: the diff really does not mention the function being duplicated', () => {
      // The case only measures anything if the baseline is genuinely blind. If the
      // original were in the diff, a diff-only reviewer could spot the duplication too and
      // a win here would be unattributable.
      const { impact } = built.get('duplicate-logic')!;
      expect(impact.changedFiles).not.toContain('src/billing/proration.ts');
    });

    it('duplicate-logic: no OTHER structural evidence is offered', () => {
      // Otherwise a win on this case could be credited to a cycle or a layering breach
      // rather than to the duplicate evidence it exists to test.
      const { impact } = built.get('duplicate-logic')!;
      expect(impact.cycles).toEqual([]);
      expect(impact.layerViolations).toEqual([]);
    });

    it('duplicate-logic: the decoy function is outside the tolerance window', () => {
      // The file holds a second, innocuous new function. Without it the tolerance would
      // credit a finding anywhere in a one-function file, which is the matcher rule this
      // corpus is supposed to respect rather than route around.
      const defect = caseByName('duplicate-logic')!.defects[0];
      const decoyLine = 21;
      expect(Math.abs(decoyLine - defect.line)).toBeGreaterThan(defect.lineTolerance);
    });

    it('real-repo-signature-drift: the un-updated caller is in the blast radius', () => {
      // The point of vendoring real code: di-graph-builder.ts is a real second caller of
      // the changed function, in a different top-level folder, that the diff never touches.
      const { impact } = built.get('real-repo-signature-drift')!;
      expect(impact.impactedSites.map((s) => s.file)).toContain(
        'src/dataflow/builder/di-graph-builder.ts',
      );
    });

    it('real-repo-signature-drift: the diff really does not mention the un-updated caller', () => {
      const { impact } = built.get('real-repo-signature-drift')!;
      expect(impact.changedFiles).not.toContain('src/dataflow/builder/di-graph-builder.ts');
    });

    it('real-repo-new-cycle: the cycle is detected AND attributed to this change', () => {
      const { impact } = built.get('real-repo-new-cycle')!;
      const introduced = impact.cycles.filter((cycle) => cycle.introducedByChange);

      expect(introduced).toHaveLength(1);
      expect(introduced[0].nodeIds.sort()).toEqual([
        'src/graph/builder/dependency-graph-builder.ts',
        'src/graph/builder/module-specifier-resolver.ts',
      ]);
    });

    it('real-repo-new-cycle: no layering violation is offered as well', () => {
      // Otherwise a win on this case could be credited to something other than the cycle
      // evidence it exists to test.
      const { impact } = built.get('real-repo-new-cycle')!;
      expect(impact.layerViolations).toEqual([]);
    });

    it('clean-refactor: no cycle and no violation is introduced', () => {
      const { impact } = built.get('clean-refactor')!;
      expect(impact.cycles.filter((c) => c.introducedByChange)).toEqual([]);
      expect(impact.layerViolations).toEqual([]);
    });
  });

  describe('the corpus is balanced enough to be worth measuring', () => {
    it('carries defects a diff-only reviewer is blind to', () => {
      const structural = CORPUS.flatMap((c) => c.defects).filter((d) => d.kind !== 'local');
      expect(structural.length).toBeGreaterThanOrEqual(3);
    });

    it('carries a local defect, so a win can be attributed', () => {
      const local = CORPUS.flatMap((c) => c.defects).filter((d) => d.kind === 'local');
      expect(local.length).toBeGreaterThan(0);
    });

    it('carries a case with no defect at all, to measure invented findings', () => {
      expect(CORPUS.some((c) => c.defects.length === 0)).toBe(true);
    });

    it('has a case for every kind the headline metric counts', () => {
      // The cross-module catch-rate is the headline number, and a kind listed in it with
      // no case in the corpus contributes nothing while looking like coverage.
      const kinds = new Set(CORPUS.flatMap((entry) => entry.defects).map((d) => d.kind));
      for (const kind of CROSS_MODULE_KINDS) {
        expect([...kinds]).toContain(kind);
      }
    });

    it('gives every defect a unique id, since ids are how hits are counted', () => {
      const ids = CORPUS.flatMap((c) => c.defects).map((d) => d.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });
});
