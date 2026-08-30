import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChangeImpact } from '../core/types/change-impact';
import { GitRepoService } from '../ingest/git-repo.service';
import { BlastRadiusService } from './blast-radius.service';
import { ChangeImpactService } from './change-impact.service';
import { ChangedSymbolResolverService } from './changed-symbol-resolver.service';
import { CycleDetector } from './cycle-detector';
import { GraphMetricsService } from './graph-metrics';
import { ModuleGraphBuilderService } from './module-graph-builder.service';
import { ProjectLoaderService } from './project-loader.service';
import { AppConfigService } from '../config/app-config.service';
import { HeadNotCheckedOutError, ImpactService } from '../review/impact.service';
import { FixtureRepo, buildFixtureRepo } from './__fixtures__/build-fixture-repo';

/**
 * The whole graph engine, over a real git repository whose dependency structure is known
 * exactly. Nothing here is mocked: real git, real ts-morph, real language service.
 *
 * These assertions are SETS, not counts. "found more than zero impacted sites" would pass
 * for a walk that returns every file in the repository, which is the most likely way for
 * this code to be wrong.
 */
describe('ChangeImpactService (real repository)', () => {
  let fixture: FixtureRepo;
  let impact: ChangeImpact;

  const git = new GitRepoService();
  const service = new ChangeImpactService(
    new ProjectLoaderService(),
    new ModuleGraphBuilderService(),
    new CycleDetector(),
    new GraphMetricsService(),
    new ChangedSymbolResolverService(),
    new BlastRadiusService(),
    git,
  );

  beforeAll(async () => {
    fixture = buildFixtureRepo();
    const changeSet = await git.changeSet(fixture.path, 'HEAD~1', 'HEAD');
    impact = await service.compute(changeSet, { repoPath: fixture.path, maxHops: 3 });
  }, 120_000);

  afterAll(() => {
    if (fixture) rmSync(fixture.path, { recursive: true, force: true });
  });

  describe('changed symbols', () => {
    it('names the method that changed, not the file or the class', () => {
      const ids = impact.changedSymbols.map((s) => s.id);
      expect(ids).toContain('src/pricing/price.service.ts#PriceService.total');
    });

    it('records it as a method, modified and exported', () => {
      const total = impact.changedSymbols.find(
        (s) => s.id === 'src/pricing/price.service.ts#PriceService.total',
      );
      expect(total?.kind).toBe('method');
      expect(total?.changeKind).toBe('modified');
      expect(total?.exported).toBe(true);
    });

    it('does not attribute the change to an untouched sibling method', () => {
      const ids = impact.changedSymbols.map((s) => s.id);
      expect(ids).not.toContain('src/pricing/price.service.ts#PriceService.cheapest');
    });

    it('reports both changed files', () => {
      expect([...impact.changedFiles].sort()).toEqual([
        'src/domain/order.ts',
        'src/pricing/price.service.ts',
      ]);
    });
  });

  describe('blast radius', () => {
    const idsAtHop = (hops: number): string[] =>
      impact.impactedSites
        .filter((site) => site.hops === hops)
        .map((site) => site.symbolId)
        .sort();

    it('finds both direct callers of the changed method at hop 1', () => {
      const hop1 = idsAtHop(1);
      expect(hop1).toContain('src/checkout/checkout.service.ts#CheckoutService.confirm');
      expect(hop1).toContain('src/reporting/revenue.report.ts#buildRevenueRow');
    });

    it('reaches the indirect caller at hop 2', () => {
      expect(idsAtHop(2)).toContain('src/api/order.controller.ts#OrderController.create');
    });

    it('never reports the unrelated module — the control', () => {
      const files = impact.impactedSites.map((site) => site.file);
      expect(files).not.toContain('src/util/format.ts');
    });

    it('records each site at its shortest distance only', () => {
      const byId = new Map<string, number[]>();
      for (const site of impact.impactedSites) {
        byId.set(site.symbolId, [...(byId.get(site.symbolId) ?? []), site.hops]);
      }
      for (const [, hops] of byId) {
        expect(hops).toHaveLength(1);
      }
    });

    it('traces every site back to a symbol that actually changed', () => {
      const changedIds = new Set(impact.changedSymbols.map((s) => s.id));
      for (const site of impact.impactedSites) {
        expect(changedIds.has(site.viaSymbolId)).toBe(true);
      }
    });

    it('does not count the changed symbol as impacting itself', () => {
      const ids = impact.impactedSites.map((site) => site.symbolId);
      expect(ids).not.toContain('src/pricing/price.service.ts#PriceService.total');
    });

    it('respects the hop limit', () => {
      for (const site of impact.impactedSites) {
        expect(site.hops).toBeLessThanOrEqual(3);
      }
    });

    it('carries the module fan-in used for ranking', () => {
      const checkout = impact.impactedSites.find(
        (s) => s.file === 'src/checkout/checkout.service.ts',
      );
      expect(checkout?.moduleFanIn).toBeGreaterThan(0);
    });
  });

  describe('cycles', () => {
    it('reports a pre-existing cycle as NOT introduced by this change', () => {
      // Touching code inside a cycle is riskier than the diff looks, so it is still
      // reported — but blaming the author for it would be wrong.
      const preExisting = impact.cycles.filter((cycle) => !cycle.introducedByChange);
      expect(preExisting).toHaveLength(1);
      expect(preExisting[0].nodeIds).toEqual(['src/legacy/left.ts', 'src/legacy/right.ts']);
    });

    it('reports the cycle the change introduced', () => {
      const introduced = impact.cycles.filter((cycle) => cycle.introducedByChange);
      expect(introduced).toHaveLength(1);
      expect(introduced[0].nodeIds).toEqual([
        'src/checkout/checkout.service.ts',
        'src/pricing/price.service.ts',
      ]);
    });
  });

  describe('architecture rules', () => {
    it('flags the forbidden edge and quotes the rule that forbids it', () => {
      const violation = impact.layerViolations.find((v) => v.fromModule === 'src/domain/order.ts');
      expect(violation).toBeDefined();
      expect(violation?.toModule).toBe('src/infra/db.ts');
      expect(violation?.rule).toBe('deny src/domain/** -> src/infra/**');
    });

    it('marks it as introduced by this change, since the edge is new', () => {
      const violation = impact.layerViolations.find((v) => v.fromModule === 'src/domain/order.ts');
      expect(violation?.introducedByChange).toBe(true);
    });

    it('reports no other violations', () => {
      expect(impact.layerViolations).toHaveLength(1);
    });
  });

  describe('guarding against analysing the wrong revision', () => {
    it('refuses a head ref that is not the checked-out revision', async () => {
      // The graph is built from the files on disk. Accepting another ref silently
      // resolved the diff's line numbers against different code, and the output looked
      // entirely normal.
      const impacts = new ImpactService(git, service, {
        blastRadiusMaxHops: 3,
      } as AppConfigService);

      await expect(
        impacts.compute({ repoPath: fixture.path, baseRef: 'HEAD~1', headRef: 'HEAD~1' }),
      ).rejects.toBeInstanceOf(HeadNotCheckedOutError);
    });

    it('accepts the checked-out revision', async () => {
      const impacts = new ImpactService(git, service, {
        blastRadiusMaxHops: 1,
      } as AppConfigService);

      await expect(
        impacts.compute({ repoPath: fixture.path, baseRef: 'HEAD~1', headRef: 'HEAD' }),
      ).resolves.toBeDefined();
    });
  });

  describe('metrics and stats', () => {
    it('reports instability only for the modules the diff touched', () => {
      expect(impact.instabilityDeltas.map((d) => d.module).sort()).toEqual([
        'src/domain/order.ts',
        'src/pricing/price.service.ts',
      ]);
    });

    it('shows domain/order.ts becoming less stable, since it gained a dependency', () => {
      const order = impact.instabilityDeltas.find((d) => d.module === 'src/domain/order.ts');
      expect(order?.before?.instability).toBe(0);
      expect(order?.after.instability).toBeGreaterThan(0);
    });

    it('counts the modules and edges it analysed', () => {
      expect(impact.stats.moduleCount).toBe(9);
      expect(impact.stats.edgeCount).toBeGreaterThan(0);
      expect(impact.stats.hopLimit).toBe(3);
    });

    it('records the base and head refs it was given', () => {
      expect(impact.repo.baseRef).toBe('HEAD~1');
      expect(impact.repo.headRef).toBe('HEAD');
    });
  });
});
