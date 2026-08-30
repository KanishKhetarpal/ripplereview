import { Injectable } from '@nestjs/common';
import { ModuleGraph } from './interfaces/module-graph.interface';

export interface StronglyConnectedComponent {
  /**
   * Module ids in this component. Length > 1 is a real cycle; length 1 means either an
   * isolated module or a self-import.
   */
  nodeIds: string[];
}

/** Work item for the explicit stack: a node and how far through its neighbours we are. */
interface Frame {
  node: string;
  neighbourIndex: number;
}

/**
 * Tarjan's strongly-connected-components algorithm, written iteratively.
 *
 * Arch Lens's version recurses once per edge followed, so its stack depth is the length of
 * the longest dependency chain in the repository. Measured against that implementation: a
 * 1,000-link chain is fine, a 5,000-link chain throws "Maximum call stack size exceeded".
 * That is well inside monorepo range, and the failure is a crash rather than a wrong
 * answer. An explicit stack removes the ceiling instead of raising it; the spec covers a
 * 50,000-link chain.
 */
@Injectable()
export class CycleDetector {
  /** All strongly connected components, including trivial singletons. */
  findComponents(graph: ModuleGraph): StronglyConnectedComponent[] {
    const adjacency = buildAdjacency(graph);

    let nextIndex = 0;
    const index = new Map<string, number>();
    const lowlink = new Map<string, number>();
    const onStack = new Set<string>();
    const tarjanStack: string[] = [];
    const components: StronglyConnectedComponent[] = [];

    for (const node of graph.nodes) {
      if (index.has(node.id)) continue;

      const callStack: Frame[] = [{ node: node.id, neighbourIndex: 0 }];
      index.set(node.id, nextIndex);
      lowlink.set(node.id, nextIndex);
      nextIndex++;
      tarjanStack.push(node.id);
      onStack.add(node.id);

      while (callStack.length > 0) {
        const frame = callStack[callStack.length - 1];
        const neighbours = adjacency.get(frame.node) ?? [];

        if (frame.neighbourIndex < neighbours.length) {
          const next = neighbours[frame.neighbourIndex];
          frame.neighbourIndex++;

          if (!index.has(next)) {
            index.set(next, nextIndex);
            lowlink.set(next, nextIndex);
            nextIndex++;
            tarjanStack.push(next);
            onStack.add(next);
            callStack.push({ node: next, neighbourIndex: 0 });
          } else if (onStack.has(next)) {
            lowlink.set(
              frame.node,
              Math.min(lowlink.get(frame.node) as number, index.get(next) as number),
            );
          }
          continue;
        }

        // Every neighbour explored: this is where the recursive form returns.
        callStack.pop();
        const parent = callStack[callStack.length - 1];
        if (parent) {
          lowlink.set(
            parent.node,
            Math.min(lowlink.get(parent.node) as number, lowlink.get(frame.node) as number),
          );
        }

        if (lowlink.get(frame.node) === index.get(frame.node)) {
          const nodeIds: string[] = [];
          let popped: string;
          do {
            popped = tarjanStack.pop() as string;
            onStack.delete(popped);
            nodeIds.push(popped);
          } while (popped !== frame.node);
          components.push({ nodeIds });
        }
      }
    }

    return components;
  }

  /** Non-trivial components only: mutual or indirect dependencies, and self-imports. */
  findCycles(graph: ModuleGraph): StronglyConnectedComponent[] {
    const selfLoops = new Set(
      graph.edges.filter((edge) => edge.from === edge.to).map((edge) => edge.from),
    );

    return this.findComponents(graph).filter(
      (component) => component.nodeIds.length > 1 || selfLoops.has(component.nodeIds[0]),
    );
  }
}

function buildAdjacency(graph: ModuleGraph): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const node of graph.nodes) {
    adjacency.set(node.id, []);
  }
  for (const edge of graph.edges) {
    adjacency.get(edge.from)?.push(edge.to);
  }
  return adjacency;
}

/**
 * A stable key for a component, so the same cycle found in two revisions compares equal
 * regardless of the order Tarjan happened to pop its members.
 */
export function componentKey(component: StronglyConnectedComponent): string {
  return [...component.nodeIds].sort().join(' -> ');
}
