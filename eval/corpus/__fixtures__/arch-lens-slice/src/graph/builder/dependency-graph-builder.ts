import { Injectable } from '@nestjs/common';
import { posix } from 'node:path';
import { ModuleSymbol } from '../../parser/interfaces/module-symbol.interface';
import { DependencyGraph, GraphEdge, GraphNode } from '../interfaces/graph.interface';
import { resolveModuleSpecifier } from './module-specifier-resolver';

@Injectable()
export class DependencyGraphBuilder {
  /**
   * Builds a DependencyGraph from normalized ModuleSymbols. One node per
   * symbol; one edge per relative import that resolves to another symbol in
   * the same set. Non-relative imports (npm packages, etc.) are recorded on
   * the node as `externalImports` rather than as edges. Re-exports
   * (`export ... from`) don't create edges here — only `import` relations do.
   */
  build(symbols: ModuleSymbol[]): DependencyGraph {
    const knownRelativePaths = new Set(symbols.map((symbol) => symbol.relativePath));
    const externalImportsByNode = new Map<string, Set<string>>();
    const edgeKeys = new Set<string>();
    const edges: GraphEdge[] = [];

    for (const symbol of symbols) {
      externalImportsByNode.set(symbol.relativePath, new Set());

      for (const importDecl of symbol.imports) {
        if (!importDecl.isRelative) {
          externalImportsByNode.get(symbol.relativePath)?.add(importDecl.moduleSpecifier);
          continue;
        }

        const resolved = resolveModuleSpecifier(
          symbol.relativePath,
          importDecl.moduleSpecifier,
          knownRelativePaths,
        );
        if (!resolved || resolved === symbol.relativePath) {
          continue;
        }

        const edgeKey = `${symbol.relativePath}=>${resolved}`;
        if (edgeKeys.has(edgeKey)) {
          continue;
        }
        edgeKeys.add(edgeKey);
        edges.push({
          from: symbol.relativePath,
          to: resolved,
          specifier: importDecl.moduleSpecifier,
        });
      }
    }

    const nodes: GraphNode[] = symbols.map((symbol) => ({
      id: symbol.relativePath,
      label: posix.basename(symbol.relativePath),
      externalImports: Array.from(externalImportsByNode.get(symbol.relativePath) ?? []).sort(),
    }));

    return { nodes, edges };
  }
}
