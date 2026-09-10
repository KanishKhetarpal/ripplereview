export interface GraphNode {
  /** Repo-relative path of the parsed file — matches ModuleSymbol.relativePath. */
  id: string;
  /** File name only, for display. */
  label: string;
  /** Bare/non-relative module specifiers imported by this file (npm packages, etc.). */
  externalImports: string[];
}

export interface GraphEdge {
  /** relativePath of the importing module. */
  from: string;
  /** relativePath of the imported module. */
  to: string;
  /** Raw specifier as written in the import, e.g. "./cats.service". */
  specifier: string;
}

export interface DependencyGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
