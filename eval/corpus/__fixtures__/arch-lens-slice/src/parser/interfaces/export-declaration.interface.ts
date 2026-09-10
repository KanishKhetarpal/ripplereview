export interface ExportedBinding {
  /** Local/original name being exported. */
  name: string;
  /** Alias name, if renamed via "as". */
  alias?: string;
}

export interface ExportDeclarationInfo {
  /** Re-export source, e.g. "./cats.service"; undefined for a bare "export default <expr>". */
  moduleSpecifier?: string;
  /** True for "export * from ..." (optionally "export * as ns from ..."). */
  isWildcard: boolean;
  /** Alias for a wildcard export, e.g. "export * as ns from ...". */
  wildcardAlias?: string;
  bindings: ExportedBinding[];
  isTypeOnly: boolean;
  /** True for a bare "export default <expr>" assignment (not a class/function declaration). */
  isDefaultExpression: boolean;
}
