import { describe, expect, it } from 'vitest';
import { ChangeImpact, ImpactedSite } from '../core/types/change-impact';
import { EvidenceBuilder, shortName } from './evidence-builder';

const builder = new EvidenceBuilder();

function impact(overrides: Partial<ChangeImpact> = {}): ChangeImpact {
  return {
    repo: { root: '/repo', baseRef: 'main', headRef: 'feature' },
    changedFiles: [],
    changedSymbols: [
      {
        id: 'src/a.ts#doThing',
        name: 'doThing',
        kind: 'function',
        file: 'src/a.ts',
        line: 1,
        changeKind: 'modified',
        exported: true,
      },
    ],
    impactedSites: [],
    cycles: [],
    layerViolations: [],
    instabilityDeltas: [],
    unanalysedFiles: [],
    stats: {
      hopLimit: 3,
      warmUpMs: 0,
      lookupMs: 0,
      lookups: 0,
      moduleCount: 1,
      edgeCount: 0,
      impactedSiteCount: 0,
      durationMs: 0,
    },
    ...overrides,
  };
}

const site = (file: string, hops: number, fanIn: number): ImpactedSite => ({
  symbolId: `${file}#fn`,
  file,
  line: 7,
  hops,
  viaSymbolId: 'src/a.ts#doThing',
  moduleFanIn: fanIn,
});

describe('EvidenceBuilder', () => {
  it('assigns sequential ids in rank order', () => {
    const items = builder.build(
      impact({ impactedSites: [site('src/x.ts', 2, 1), site('src/y.ts', 1, 1)] }),
    );
    expect(items.map((i) => i.id)).toEqual(['E1', 'E2']);
    expect(items[0].location?.file).toBe('src/y.ts');
  });

  it('distinguishes an introduced cycle from a pre-existing one in the wording', () => {
    const items = builder.build(
      impact({
        cycles: [
          { nodeIds: ['a.ts', 'b.ts'], introducedByChange: true },
          { nodeIds: ['c.ts', 'd.ts'], introducedByChange: false },
        ],
      }),
    );

    const introduced = items.find((i) => i.summary.includes('a.ts'));
    const existing = items.find((i) => i.summary.includes('c.ts'));
    expect(introduced?.summary).toContain('INTRODUCES');
    expect(existing?.summary).toContain('Pre-existing');
    expect(existing?.summary).toContain('not introduced here');
  });

  it('ranks an introduced cycle above a pre-existing one', () => {
    const items = builder.build(
      impact({
        cycles: [
          { nodeIds: ['c.ts', 'd.ts'], introducedByChange: false },
          { nodeIds: ['a.ts', 'b.ts'], introducedByChange: true },
        ],
      }),
    );
    expect(items[0].summary).toContain('INTRODUCES');
  });

  it('closes the cycle in the rendered path, so it reads as a loop', () => {
    const items = builder.build(
      impact({ cycles: [{ nodeIds: ['a.ts', 'b.ts'], introducedByChange: true }] }),
    );
    expect(items[0].summary).toContain('a.ts -> b.ts -> a.ts');
  });

  it('quotes the architecture rule verbatim', () => {
    const items = builder.build(
      impact({
        layerViolations: [
          {
            rule: 'deny src/domain/** -> src/infra/**',
            fromModule: 'src/domain/o.ts',
            toModule: 'src/infra/db.ts',
            specifier: '../infra/db',
            introducedByChange: true,
          },
        ],
      }),
    );
    expect(items[0].summary).toContain('"deny src/domain/** -> src/infra/**"');
  });

  it('names the changed symbol a site depends on, not its raw id', () => {
    const items = builder.build(impact({ impactedSites: [site('src/x.ts', 1, 3)] }));
    expect(items[0].summary).toContain('the changed doThing');
    expect(items[0].summary).not.toContain('src/a.ts#doThing');
  });

  it('pluralises hops correctly, since the line is read by a person', () => {
    const one = builder.build(impact({ impactedSites: [site('src/x.ts', 1, 0)] }));
    const two = builder.build(impact({ impactedSites: [site('src/x.ts', 2, 0)] }));
    expect(one[0].summary).toContain('1 hop away');
    expect(two[0].summary).toContain('2 hops away');
  });

  it('weights a nearer site above a further one', () => {
    const items = builder.build(
      impact({ impactedSites: [site('src/far.ts', 3, 50), site('src/near.ts', 1, 0)] }),
    );
    expect(items[0].location?.file).toBe('src/near.ts');
  });

  it('never lets fan-in outrank hop distance', () => {
    // Fan-in is capped when it contributes to the weight, so a hub three hops away cannot
    // displace a direct caller — which is what actually breaks first.
    const items = builder.build(
      impact({ impactedSites: [site('src/hub.ts', 2, 100000), site('src/near.ts', 1, 0)] }),
    );
    expect(items[0].location?.file).toBe('src/near.ts');
  });

  it('omits an instability delta that did not move', () => {
    const items = builder.build(
      impact({
        instabilityDeltas: [
          {
            module: 'src/a.ts',
            before: { fanIn: 1, fanOut: 1, instability: 0.5 },
            after: { fanIn: 1, fanOut: 1, instability: 0.5 },
          },
        ],
      }),
    );
    expect(items).toEqual([]);
  });

  it('includes an instability delta that did move', () => {
    const items = builder.build(
      impact({
        instabilityDeltas: [
          {
            module: 'src/a.ts',
            before: { fanIn: 1, fanOut: 0, instability: 0 },
            after: { fanIn: 1, fanOut: 1, instability: 0.5 },
          },
        ],
      }),
    );
    expect(items[0].summary).toContain('0.00 -> 0.50');
  });

  it('describes a brand-new module as new rather than showing a bogus delta', () => {
    const items = builder.build(
      impact({
        instabilityDeltas: [
          { module: 'src/new.ts', before: null, after: { fanIn: 0, fanOut: 2, instability: 1 } },
        ],
      }),
    );
    expect(items[0].summary).toContain('is new');
  });

  it('produces nothing for a change with no graph consequences', () => {
    expect(builder.build(impact())).toEqual([]);
  });
});

describe('shortName', () => {
  it('drops the path from a symbol id', () => {
    expect(shortName('src/a/b.ts#Class.method')).toBe('Class.method');
  });

  it('leaves an id with no path alone', () => {
    expect(shortName('bare')).toBe('bare');
  });
});
