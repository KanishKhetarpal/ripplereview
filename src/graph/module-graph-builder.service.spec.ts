import { Project, SourceFile } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { ModuleGraphBuilderService } from './module-graph-builder.service';

const builder = new ModuleGraphBuilderService();

function parse(content: string): SourceFile {
  const project = new Project({ useInMemoryFileSystem: true });
  return project.createSourceFile('/src/a.ts', content);
}

describe('extractSpecifiers', () => {
  it('finds a static import', () => {
    expect(builder.extractSpecifiers(parse("import { x } from './b';"))).toEqual(['./b']);
  });

  it('finds a side-effect import with no bindings', () => {
    expect(builder.extractSpecifiers(parse("import './polyfill';"))).toEqual(['./polyfill']);
  });

  it('finds a type-only import, which is still a dependency in the graph', () => {
    expect(builder.extractSpecifiers(parse("import type { X } from './b';"))).toEqual(['./b']);
  });

  it('finds a re-export, where barrel-file cycles hide', () => {
    expect(builder.extractSpecifiers(parse("export * from './b';"))).toEqual(['./b']);
    expect(builder.extractSpecifiers(parse("export { x } from './b';"))).toEqual(['./b']);
  });

  it('ignores a local export, which names no module', () => {
    expect(builder.extractSpecifiers(parse('const x = 1;\nexport { x };'))).toEqual([]);
  });

  it('finds a dynamic import with a literal specifier', () => {
    const file = parse("export async function load() { return import('./b'); }");
    expect(builder.extractSpecifiers(file)).toEqual(['./b']);
  });

  it('skips a computed dynamic import rather than guessing at it', () => {
    const file = parse('export async function load(n: string) { return import(n); }');
    expect(builder.extractSpecifiers(file)).toEqual([]);
  });

  it('does not mistake a normal call for a dynamic import', () => {
    expect(builder.extractSpecifiers(parse("doSomething('./b');"))).toEqual([]);
  });
});

describe('build', () => {
  it('creates an edge for a resolvable relative import', () => {
    const graph = builder.build([
      { relativePath: 'src/a.ts', specifiers: ['./b'] },
      { relativePath: 'src/b.ts', specifiers: [] },
    ]);
    expect(graph.edges).toEqual([{ from: 'src/a.ts', to: 'src/b.ts', specifier: './b' }]);
  });

  it('resolves a directory import to its index file', () => {
    const graph = builder.build([
      { relativePath: 'src/a.ts', specifiers: ['./core'] },
      { relativePath: 'src/core/index.ts', specifiers: [] },
    ]);
    expect(graph.edges[0].to).toBe('src/core/index.ts');
  });

  it('resolves a .js specifier to the .ts file it was written for', () => {
    // NodeNext requires the emitted extension in source; a graph that only tried .js
    // would find no edges at all in such a project.
    const graph = builder.build([
      { relativePath: 'src/a.ts', specifiers: ['./b.js'] },
      { relativePath: 'src/b.ts', specifiers: [] },
    ]);
    expect(graph.edges[0].to).toBe('src/b.ts');
  });

  it('records a package import as external rather than as an edge', () => {
    const graph = builder.build([{ relativePath: 'src/a.ts', specifiers: ['@nestjs/common'] }]);
    expect(graph.edges).toEqual([]);
    expect(graph.nodes[0].externalImports).toEqual(['@nestjs/common']);
  });

  it('creates no edge for a relative specifier that resolves to nothing', () => {
    const graph = builder.build([{ relativePath: 'src/a.ts', specifiers: ['./missing'] }]);
    expect(graph.edges).toEqual([]);
    // Neither an edge nor external: it is neither, and claiming either corrupts a count.
    expect(graph.nodes[0].externalImports).toEqual([]);
  });

  it('counts two imports of the same module as one dependency', () => {
    // A `import type` beside a value import would otherwise double that module's fan-in.
    const graph = builder.build([
      { relativePath: 'src/a.ts', specifiers: ['./b', './b'] },
      { relativePath: 'src/b.ts', specifiers: [] },
    ]);
    expect(graph.edges).toHaveLength(1);
  });

  it('deduplicates external imports', () => {
    const graph = builder.build([{ relativePath: 'src/a.ts', specifiers: ['rxjs', 'rxjs'] }]);
    expect(graph.nodes[0].externalImports).toEqual(['rxjs']);
  });

  it('keeps a node for a module with no imports at all', () => {
    const graph = builder.build([{ relativePath: 'src/lonely.ts', specifiers: [] }]);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges).toEqual([]);
  });

  it('resolves an import that walks up a directory', () => {
    const graph = builder.build([
      { relativePath: 'src/deep/a.ts', specifiers: ['../b'] },
      { relativePath: 'src/b.ts', specifiers: [] },
    ]);
    expect(graph.edges[0].to).toBe('src/b.ts');
  });
});
