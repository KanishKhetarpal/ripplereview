export type ImportBindingKind = 'default' | 'named' | 'namespace';

export interface ImportedBinding {
  /** Local name bound in the importing file. */
  name: string;
  /** Original exported name for a named import; undefined for default/namespace. */
  importedName?: string;
  kind: ImportBindingKind;
}

export interface ImportDeclarationInfo {
  /** Raw module specifier as written, e.g. "./cats.service" or "@nestjs/common". */
  moduleSpecifier: string;
  /** True when the specifier starts with "./" or "../". */
  isRelative: boolean;
  bindings: ImportedBinding[];
  isTypeOnly: boolean;
}
