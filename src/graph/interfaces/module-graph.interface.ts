/** A module is one source file, identified by its repo-relative POSIX path. */
export interface ModuleNode {
  id: string;
  /** Bare specifiers this file imports (npm packages), kept out of the internal graph. */
  externalImports: string[];
}

export interface ModuleEdge {
  /** relativePath of the importing module. */
  from: string;
  /** relativePath of the imported module. */
  to: string;
  /** The specifier as written in source, e.g. "./pricing". */
  specifier: string;
}

export interface ModuleGraph {
  nodes: ModuleNode[];
  edges: ModuleEdge[];
}

/** The raw material a graph is built from: one file's outgoing specifiers. */
export interface ModuleImports {
  relativePath: string;
  specifiers: string[];
}
