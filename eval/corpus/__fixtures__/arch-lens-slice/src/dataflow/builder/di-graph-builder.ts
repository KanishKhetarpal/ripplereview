import { Injectable } from '@nestjs/common';
import { resolveModuleSpecifier } from '../../graph/builder/module-specifier-resolver';
import { ModuleSymbol } from '../../parser/interfaces/module-symbol.interface';
import { classifyLayer, isDiParticipant } from '../analysis/layer-classifier';
import { DiEdge, DiGraph, DiNode } from '../interfaces/di-graph.interface';

@Injectable()
export class DiGraphBuilder {
  /**
   * Builds the dependency-injection graph: one node per DI-participating
   * class (`isDiParticipant`), one edge per constructor parameter whose type
   * resolves to another node — either imported from another module or
   * declared in the same file. Parameters whose type never resolves to a
   * known class (primitives, external types, tokens with no local class)
   * produce no edge.
   */
  build(symbols: ModuleSymbol[]): DiGraph {
    const nodes: DiNode[] = [];
    const knownNodeIds = new Set<string>();

    for (const symbol of symbols) {
      for (const cls of symbol.classes) {
        if (!isDiParticipant(cls)) {
          continue;
        }
        const id = `${symbol.relativePath}#${cls.name}`;
        nodes.push({
          id,
          relativePath: symbol.relativePath,
          className: cls.name,
          layer: classifyLayer(cls),
        });
        knownNodeIds.add(id);
      }
    }

    const knownRelativePaths = new Set(symbols.map((symbol) => symbol.relativePath));
    const edges: DiEdge[] = [];

    for (const symbol of symbols) {
      const importedFrom = this.resolveImportedTypeOrigins(symbol, knownRelativePaths);

      for (const cls of symbol.classes) {
        if (!isDiParticipant(cls)) {
          continue;
        }
        const fromId = `${symbol.relativePath}#${cls.name}`;

        for (const param of cls.constructorParams) {
          const typeName = this.normalizeTypeName(param.typeName);
          if (!typeName) {
            continue;
          }

          const targetPath =
            importedFrom.get(typeName) ??
            (symbol.classes.some((candidate) => candidate.name === typeName)
              ? symbol.relativePath
              : undefined);
          const toId = targetPath ? `${targetPath}#${typeName}` : undefined;
          if (!toId || !knownNodeIds.has(toId) || toId === fromId) {
            continue;
          }

          edges.push({
            from: fromId,
            to: toId,
            paramName: param.name,
            token: param.decorators.find((decorator) => decorator.name === 'Inject')?.arguments[0],
          });
        }
      }
    }

    return { nodes, edges };
  }

  private resolveImportedTypeOrigins(
    symbol: ModuleSymbol,
    knownRelativePaths: ReadonlySet<string>,
  ): Map<string, string> {
    const origins = new Map<string, string>();

    for (const importDecl of symbol.imports) {
      if (!importDecl.isRelative) {
        continue;
      }
      const resolved = resolveModuleSpecifier(
        symbol.relativePath,
        importDecl.moduleSpecifier,
        knownRelativePaths,
      );
      if (!resolved) {
        continue;
      }
      for (const binding of importDecl.bindings) {
        origins.set(binding.name, resolved);
      }
    }

    return origins;
  }

  /** Strips generic args and array suffixes, e.g. "Repository<Cat>" -> "Repository", "Cat[]" -> "Cat". */
  private normalizeTypeName(typeName: string | undefined): string | undefined {
    if (!typeName) {
      return undefined;
    }
    const stripped = typeName
      .replace(/<[\s\S]*>$/, '')
      .replace(/(\[\])+$/, '')
      .trim();
    return stripped.length > 0 ? stripped : undefined;
  }
}
