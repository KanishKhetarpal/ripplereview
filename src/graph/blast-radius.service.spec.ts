import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { ModuleMetrics } from '../core/types/change-impact';
import { BlastRadiusService } from './blast-radius.service';
import { ModuleGraph } from './interfaces/module-graph.interface';
import { LocatedSymbol, MODULE_SCOPE, locateAtLine } from './symbol-locator';

const ROOT = '/repo';

interface Fixture {
  project: Project;
  changed: LocatedSymbol[];
}

/**
 * Builds an in-memory project and locates one symbol by name, the way the resolver would.
 * In-memory because the assertions here are about which references survive filtering, and
 * that needs precise control over what each file does with an import.
 */
function fixture(files: Record<string, string>, changedFile: string, marker: string): Fixture {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [path, content] of Object.entries(files)) {
    project.createSourceFile(`${ROOT}/${path}`, content);
  }

  const source = project.getSourceFileOrThrow(`${ROOT}/${changedFile}`);
  const line = files[changedFile].split('\n').findIndex((l) => l.includes(marker)) + 1;
  const located = locateAtLine(source, changedFile, line);
  if (!located) throw new Error(`could not locate "${marker}" in ${changedFile}`);

  return { project, changed: [located] };
}

const service = new BlastRadiusService();
const noMetrics = new Map<string, ModuleMetrics>();

const run = (f: Fixture, maxHops = 3): ReturnType<BlastRadiusService['compute']> =>
  service.compute(f.project, f.changed, { maxHops, repoRoot: ROOT, moduleMetrics: noMetrics });

describe('BlastRadiusService', () => {
  it('reports a module that calls the changed symbol', () => {
    const f = fixture(
      {
        'src/pricing.ts': 'export function total(): number {\n  return 1;\n}\n',
        'src/caller.ts':
          "import { total } from './pricing';\nexport function confirm(): number {\n  return total();\n}\n",
      },
      'src/pricing.ts',
      'export function total',
    );

    const result = run(f);
    expect(result.sites.map((s) => s.symbolId)).toEqual(['src/caller.ts#confirm']);
    expect(result.sites[0].hops).toBe(1);
  });

  it('does NOT report a module that only imports the symbol without using it', () => {
    // The language service returns the import specifier as a reference. Counted, every
    // importer becomes an impacted site — and because the import sits at module scope,
    // the whole file is reported as impacted whether or not anything in it uses the symbol.
    const f = fixture(
      {
        'src/pricing.ts': 'export function total(): number {\n  return 1;\n}\n',
        'src/importer.ts': "import { total } from './pricing';\nexport const unrelated = 1;\n",
      },
      'src/pricing.ts',
      'export function total',
    );

    expect(run(f).sites).toEqual([]);
  });

  it('does NOT report a barrel file that merely re-exports the symbol', () => {
    const f = fixture(
      {
        'src/pricing.ts': 'export function total(): number {\n  return 1;\n}\n',
        'src/index.ts': "export { total } from './pricing';\n",
      },
      'src/pricing.ts',
      'export function total',
    );

    expect(run(f).sites).toEqual([]);
  });

  it('follows a use through a barrel file to the module that actually calls it', () => {
    const f = fixture(
      {
        'src/pricing.ts': 'export function total(): number {\n  return 1;\n}\n',
        'src/index.ts': "export { total } from './pricing';\n",
        'src/caller.ts':
          "import { total } from './index';\nexport function confirm(): number {\n  return total();\n}\n",
      },
      'src/pricing.ts',
      'export function total',
    );

    expect(run(f).sites.map((s) => s.symbolId)).toEqual(['src/caller.ts#confirm']);
  });

  it('walks a second hop to the caller of the caller', () => {
    const f = fixture(
      {
        'src/pricing.ts': 'export function total(): number {\n  return 1;\n}\n',
        'src/caller.ts':
          "import { total } from './pricing';\nexport function confirm(): number {\n  return total();\n}\n",
        'src/api.ts':
          "import { confirm } from './caller';\nexport function handle(): number {\n  return confirm();\n}\n",
      },
      'src/pricing.ts',
      'export function total',
    );

    const result = run(f);
    const byId = new Map(result.sites.map((s) => [s.symbolId, s.hops]));
    expect(byId.get('src/caller.ts#confirm')).toBe(1);
    expect(byId.get('src/api.ts#handle')).toBe(2);
  });

  it('stops at the hop limit', () => {
    const f = fixture(
      {
        'src/pricing.ts': 'export function total(): number {\n  return 1;\n}\n',
        'src/caller.ts':
          "import { total } from './pricing';\nexport function confirm(): number {\n  return total();\n}\n",
        'src/api.ts':
          "import { confirm } from './caller';\nexport function handle(): number {\n  return confirm();\n}\n",
      },
      'src/pricing.ts',
      'export function total',
    );

    const result = run(f, 1);
    expect(result.sites.map((s) => s.symbolId)).toEqual(['src/caller.ts#confirm']);
  });

  it('never reports the changed symbol as impacting itself', () => {
    const f = fixture(
      {
        'src/pricing.ts':
          'export function total(): number {\n  return 1;\n}\nexport const twice = total() * 2;\n',
      },
      'src/pricing.ts',
      'export function total',
    );

    expect(run(f).sites.map((s) => s.symbolId)).not.toContain('src/pricing.ts#total');
  });

  it('attributes every site to the changed symbol the walk started from', () => {
    const f = fixture(
      {
        'src/pricing.ts': 'export function total(): number {\n  return 1;\n}\n',
        'src/caller.ts':
          "import { total } from './pricing';\nexport function confirm(): number {\n  return total();\n}\n",
      },
      'src/pricing.ts',
      'export function total',
    );

    for (const site of run(f).sites) {
      expect(site.viaSymbolId).toBe('src/pricing.ts#total');
    }
  });

  it('counts the reference lookups it performed', () => {
    const f = fixture(
      { 'src/pricing.ts': 'export function total(): number {\n  return 1;\n}\n' },
      'src/pricing.ts',
      'export function total',
    );

    expect(run(f).lookups).toBe(1);
    expect(run(f).truncated).toBe(false);
  });

  it('reports truncation rather than silently returning a partial radius', () => {
    const f = fixture(
      {
        'src/pricing.ts': 'export function total(): number {\n  return 1;\n}\n',
        'src/caller.ts':
          "import { total } from './pricing';\nexport function confirm(): number {\n  return total();\n}\n",
      },
      'src/pricing.ts',
      'export function total',
    );

    const result = service.compute(f.project, f.changed, {
      maxHops: 3,
      repoRoot: ROOT,
      moduleMetrics: noMetrics,
      maxLookups: 0,
    });

    expect(result.truncated).toBe(true);
    expect(result.sites).toEqual([]);
  });

  it('ignores a reference in a file outside the repository root', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      `${ROOT}/src/pricing.ts`,
      'export function total(): number {\n  return 1;\n}\n',
    );
    project.createSourceFile(
      '/elsewhere/consumer.ts',
      "import { total } from '../repo/src/pricing';\nexport function use(): number {\n  return total();\n}\n",
    );

    const source = project.getSourceFileOrThrow(`${ROOT}/src/pricing.ts`);
    const located = locateAtLine(source, 'src/pricing.ts', 1);
    if (!located) throw new Error('locate failed');

    const result = service.compute(project, [located], {
      maxHops: 3,
      repoRoot: ROOT,
      moduleMetrics: noMetrics,
    });

    expect(result.sites).toEqual([]);
  });
});

describe('BlastRadiusService and module-scope changes', () => {
  const moduleGraph: ModuleGraph = {
    nodes: ['src/core.ts', 'src/mid.ts', 'src/top.ts', 'src/unrelated.ts'].map((id) => ({
      id,
      externalImports: [],
    })),
    edges: [
      { from: 'src/mid.ts', to: 'src/core.ts', specifier: './core' },
      { from: 'src/top.ts', to: 'src/mid.ts', specifier: './mid' },
    ],
  };

  /** A module-scope change: an edited import, with no declaration to look up. */
  const moduleScopeChange: LocatedSymbol = {
    id: `src/core.ts#${MODULE_SCOPE}`,
    name: MODULE_SCOPE,
    kind: 'unknown',
    file: 'src/core.ts',
    line: 1,
    exported: true,
  };

  const project = new Project({ useInMemoryFileSystem: true });

  const walk = (maxHops: number): ReturnType<BlastRadiusService['compute']> =>
    service.compute(project, [moduleScopeChange], {
      maxHops,
      repoRoot: ROOT,
      moduleMetrics: noMetrics,
      moduleGraph,
    });

  it('reports the modules that import the changed one', () => {
    // Before this, a module-scope change reported nothing at all: there is no declaration
    // to find references to, so the branch ended silently and an edited import looked
    // impact-free.
    expect(walk(3).sites.map((s) => s.file)).toContain('src/mid.ts');
  });

  it('walks transitively, so a second-order dependant is found', () => {
    const byFile = new Map(walk(3).sites.map((s) => [s.file, s.hops]));
    expect(byFile.get('src/mid.ts')).toBe(1);
    expect(byFile.get('src/top.ts')).toBe(2);
  });

  it('never reports a module that does not import it', () => {
    expect(walk(3).sites.map((s) => s.file)).not.toContain('src/unrelated.ts');
  });

  it('respects the hop limit', () => {
    expect(walk(1).sites.map((s) => s.file)).toEqual(['src/mid.ts']);
  });

  it('reports at module granularity, which is all it actually knows', () => {
    const [first] = walk(3).sites;
    expect(first.symbolId).toBe(`src/mid.ts#${MODULE_SCOPE}`);
    expect(first.line).toBe(1);
  });

  it('spends no reference lookups, since there is no declaration to look up', () => {
    expect(walk(3).lookups).toBe(0);
  });

  it('reports nothing when no module graph is supplied', () => {
    const result = service.compute(project, [moduleScopeChange], {
      maxHops: 3,
      repoRoot: ROOT,
      moduleMetrics: noMetrics,
    });
    expect(result.sites).toEqual([]);
  });

  it('caps how many dependants it lists, so a hub module cannot drown the evidence', () => {
    const wide: ModuleGraph = {
      nodes: [
        { id: 'src/core.ts', externalImports: [] },
        ...Array.from({ length: 200 }, (_, i) => ({
          id: `src/dep${i}.ts`,
          externalImports: [],
        })),
      ],
      edges: Array.from({ length: 200 }, (_, i) => ({
        from: `src/dep${i}.ts`,
        to: 'src/core.ts',
        specifier: './core',
      })),
    };

    const result = service.compute(project, [moduleScopeChange], {
      maxHops: 3,
      repoRoot: ROOT,
      moduleMetrics: noMetrics,
      moduleGraph: wide,
      maxModuleDependants: 5,
    });

    expect(result.sites).toHaveLength(5);
  });
});
