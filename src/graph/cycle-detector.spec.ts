import { describe, expect, it } from 'vitest';
import { CycleDetector, componentKey } from './cycle-detector';
import { ModuleGraph } from './interfaces/module-graph.interface';

function graph(edges: [string, string][], extraNodes: string[] = []): ModuleGraph {
  const ids = new Set<string>(extraNodes);
  for (const [from, to] of edges) {
    ids.add(from);
    ids.add(to);
  }
  return {
    nodes: [...ids].map((id) => ({ id, externalImports: [] })),
    edges: edges.map(([from, to]) => ({ from, to, specifier: `./${to}` })),
  };
}

describe('CycleDetector', () => {
  const detector = new CycleDetector();

  it('finds no cycle in an acyclic graph', () => {
    const cycles = detector.findCycles(
      graph([
        ['a', 'b'],
        ['b', 'c'],
      ]),
    );
    expect(cycles).toEqual([]);
  });

  it('finds a two-module mutual dependency', () => {
    const cycles = detector.findCycles(
      graph([
        ['a', 'b'],
        ['b', 'a'],
      ]),
    );
    expect(cycles).toHaveLength(1);
    expect([...cycles[0].nodeIds].sort()).toEqual(['a', 'b']);
  });

  it('finds an indirect cycle through a third module', () => {
    const cycles = detector.findCycles(
      graph([
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'a'],
      ]),
    );
    expect(cycles).toHaveLength(1);
    expect([...cycles[0].nodeIds].sort()).toEqual(['a', 'b', 'c']);
  });

  it('treats a self-import as a cycle', () => {
    const cycles = detector.findCycles(graph([['a', 'a']]));
    expect(cycles).toHaveLength(1);
    expect(cycles[0].nodeIds).toEqual(['a']);
  });

  it('does not treat an isolated module as a cycle', () => {
    const cycles = detector.findCycles(graph([], ['lonely']));
    expect(cycles).toEqual([]);
  });

  it('separates two independent cycles', () => {
    const cycles = detector.findCycles(
      graph([
        ['a', 'b'],
        ['b', 'a'],
        ['c', 'd'],
        ['d', 'c'],
      ]),
    );
    expect(cycles).toHaveLength(2);
    expect(cycles.map(componentKey).sort()).toEqual(['a -> b', 'c -> d']);
  });

  it('reports one component for two cycles sharing a module', () => {
    // a<->b and b<->c are one SCC {a,b,c}, not two.
    const cycles = detector.findCycles(
      graph([
        ['a', 'b'],
        ['b', 'a'],
        ['b', 'c'],
        ['c', 'b'],
      ]),
    );
    expect(cycles).toHaveLength(1);
    expect([...cycles[0].nodeIds].sort()).toEqual(['a', 'b', 'c']);
  });

  it('still reports every module as a component, cyclic or not', () => {
    const components = detector.findComponents(
      graph([
        ['a', 'b'],
        ['b', 'c'],
      ]),
    );
    expect(components).toHaveLength(3);
  });

  it('ignores an edge pointing at a module that is not in the graph', () => {
    const g: ModuleGraph = {
      nodes: [{ id: 'a', externalImports: [] }],
      edges: [{ from: 'a', to: 'ghost', specifier: './ghost' }],
    };
    expect(() => detector.findCycles(g)).not.toThrow();
    expect(detector.findCycles(g)).toEqual([]);
  });

  it('survives a chain deep enough to overflow a recursive implementation', () => {
    // 50k links. The recursive form this replaced recurses once per edge followed and
    // dies here with RangeError: Maximum call stack size exceeded.
    const depth = 50_000;
    const edges: [string, string][] = [];
    for (let i = 0; i < depth; i++) {
      edges.push([`n${i}`, `n${i + 1}`]);
    }
    // Close the very end into a cycle so there is something to find.
    edges.push([`n${depth}`, `n${depth - 1}`]);

    const cycles = detector.findCycles(graph(edges));

    expect(cycles).toHaveLength(1);
    expect([...cycles[0].nodeIds].sort()).toEqual([`n${depth - 1}`, `n${depth}`].sort());
  });
});

describe('componentKey', () => {
  it('is independent of the order Tarjan popped the members', () => {
    expect(componentKey({ nodeIds: ['b', 'a', 'c'] })).toBe(
      componentKey({ nodeIds: ['c', 'b', 'a'] }),
    );
  });

  it('distinguishes different components', () => {
    expect(componentKey({ nodeIds: ['a', 'b'] })).not.toBe(componentKey({ nodeIds: ['a', 'c'] }));
  });
});
