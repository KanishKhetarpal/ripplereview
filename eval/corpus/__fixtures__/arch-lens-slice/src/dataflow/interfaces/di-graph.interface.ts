export type ArchitecturalLayer = 'controller' | 'service' | 'repository' | 'other';

export interface DiNode {
  /** `${relativePath}#${className}` — unique identity for a DI-participating class. */
  id: string;
  relativePath: string;
  className: string;
  layer: ArchitecturalLayer;
}

export interface DiEdge {
  /** DiNode id of the class whose constructor performs the injection. */
  from: string;
  /** DiNode id of the injected class. */
  to: string;
  /** Constructor parameter name the dependency is bound to. */
  paramName: string;
  /** Raw `@Inject(...)` token text, if the parameter carries an explicit injection token. */
  token?: string;
}

export interface DiGraph {
  nodes: DiNode[];
  edges: DiEdge[];
}
