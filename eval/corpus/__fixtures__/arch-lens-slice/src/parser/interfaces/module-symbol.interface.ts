import { ClassDeclarationInfo } from './class-declaration.interface';
import { ExportDeclarationInfo } from './export-declaration.interface';
import { FunctionDeclarationInfo } from './function-declaration.interface';
import { ImportDeclarationInfo } from './import-declaration.interface';

/** Normalized, source-agnostic view of a single parsed file, keyed by repo-relative path. */
export interface ModuleSymbol {
  /** Path relative to the repo root, forward-slashed — matches SourceFile.relativePath. */
  relativePath: string;
  imports: ImportDeclarationInfo[];
  exports: ExportDeclarationInfo[];
  classes: ClassDeclarationInfo[];
  functions: FunctionDeclarationInfo[];
}
