import { Injectable } from '@nestjs/common';
import { ModuleMetrics } from '../core/types/change-impact';
import { ModuleGraph } from './interfaces/module-graph.interface';

@Injectable()
export class GraphMetricsService {
  /**
   * Fan-in, fan-out and Martin's instability per module.
   *
   * Instability is fanOut / (fanIn + fanOut): 0 is maximally stable (much depends on it,
   * it depends on little), 1 is maximally unstable. A module with no edges at all has no
   * meaningful ratio; it is reported as 0 rather than NaN, which would propagate into every
   * comparison silently.
   */
  compute(graph: ModuleGraph): Map<string, ModuleMetrics> {
    const fanIn = new Map<string, number>();
    const fanOut = new Map<string, number>();

    for (const node of graph.nodes) {
      fanIn.set(node.id, 0);
      fanOut.set(node.id, 0);
    }

    for (const edge of graph.edges) {
      if (fanOut.has(edge.from)) fanOut.set(edge.from, (fanOut.get(edge.from) as number) + 1);
      if (fanIn.has(edge.to)) fanIn.set(edge.to, (fanIn.get(edge.to) as number) + 1);
    }

    const metrics = new Map<string, ModuleMetrics>();
    for (const node of graph.nodes) {
      const inCount = fanIn.get(node.id) as number;
      const outCount = fanOut.get(node.id) as number;
      const total = inCount + outCount;
      metrics.set(node.id, {
        fanIn: inCount,
        fanOut: outCount,
        instability: total === 0 ? 0 : outCount / total,
      });
    }

    return metrics;
  }
}
