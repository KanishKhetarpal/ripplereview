import { Node, SourceFile as TsSourceFile, SyntaxKind } from 'ts-morph';
import { SymbolId, SymbolKind } from '../core/types/change-impact';

/**
 * The name given to a change that belongs to a file but not to any declaration in it — a
 * changed import, a moved top-level statement. It is a real change with a real blast
 * radius (everything depending on the module), so it is named rather than dropped.
 */
export const MODULE_SCOPE = '<module>';

export interface LocatedSymbol {
  id: SymbolId;
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
  exported: boolean;
  /** The identifier to hand the language service. Absent for module scope. */
  nameNode?: Node;
  /**
   * The whole declaration, not just its name — the type extractor walks it for the types
   * the change refers to. Absent for module scope, which has no declaration.
   */
  declaration?: Node;
}

/** Declaration kinds a change is attributed to, innermost first. */
const DECLARATION_KINDS = new Set<SyntaxKind>([
  SyntaxKind.MethodDeclaration,
  SyntaxKind.Constructor,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
  SyntaxKind.PropertyDeclaration,
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.ClassDeclaration,
  SyntaxKind.InterfaceDeclaration,
  SyntaxKind.TypeAliasDeclaration,
  SyntaxKind.EnumDeclaration,
  SyntaxKind.VariableDeclaration,
]);

const KIND_NAMES: Partial<Record<SyntaxKind, SymbolKind>> = {
  [SyntaxKind.MethodDeclaration]: 'method',
  [SyntaxKind.Constructor]: 'method',
  [SyntaxKind.GetAccessor]: 'method',
  [SyntaxKind.SetAccessor]: 'method',
  [SyntaxKind.PropertyDeclaration]: 'variable',
  [SyntaxKind.FunctionDeclaration]: 'function',
  [SyntaxKind.ClassDeclaration]: 'class',
  [SyntaxKind.InterfaceDeclaration]: 'interface',
  [SyntaxKind.TypeAliasDeclaration]: 'type',
  [SyntaxKind.EnumDeclaration]: 'enum',
  [SyntaxKind.VariableDeclaration]: 'variable',
};

/**
 * The declaration a node belongs to, innermost first.
 *
 * Innermost matters: a change inside `PriceService.total` is attributed to the method, not
 * to the class. Attributing it to the class would make the blast radius every reference to
 * PriceService — which is most of the application, and therefore useless.
 */
export function enclosingDeclaration(node: Node): Node | undefined {
  let current: Node | undefined = node;

  while (current) {
    if (current.getKind() === SyntaxKind.VariableDeclaration) {
      // A module-level `const` is a symbol other files can reach. A local one is not, and
      // treating it as one is not merely noisy — measured on this repository's own
      // history, a two-commit diff produced 91 "changed symbols", nearly all of them
      // locals inside test callbacks, each costing a reference lookup to discover that
      // nothing outside the function can possibly reach it.
      if (isTopLevelVariable(current)) return current;
      current = current.getParent();
      continue;
    }

    if (DECLARATION_KINDS.has(current.getKind())) return current;

    // `export const arrow = () => 3;` nests the other way round: the VariableStatement
    // CONTAINS the VariableDeclaration, so walking up from the `export` keyword at column
    // 0 sails past it to the source file and the change lands in module scope.
    if (current.getKind() === SyntaxKind.VariableStatement && isTopLevelStatement(current)) {
      const [declaration] = current
        .asKindOrThrow(SyntaxKind.VariableStatement)
        .getDeclarationList()
        .getDeclarations();
      if (declaration) return declaration;
    }

    current = current.getParent();
  }

  return undefined;
}

/** True when the variable's statement sits directly in the file, not inside a function. */
function isTopLevelVariable(declaration: Node): boolean {
  const statement = declaration.getFirstAncestorByKind(SyntaxKind.VariableStatement);
  return statement ? isTopLevelStatement(statement) : false;
}

function isTopLevelStatement(statement: Node): boolean {
  return statement.getParent()?.getKind() === SyntaxKind.SourceFile;
}

/** `Class.method` for a member, plain `name` otherwise. */
export function qualifiedName(declaration: Node): string | undefined {
  const own = declarationName(declaration);
  if (!own) return undefined;

  const owner = declaration.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
  const ownerName = owner ? owner.getName() : undefined;

  if (owner && ownerName && owner !== declaration) {
    return `${ownerName}.${own}`;
  }
  return own;
}

function declarationName(declaration: Node): string | undefined {
  if (declaration.getKind() === SyntaxKind.Constructor) return 'constructor';

  const named = declaration as unknown as { getName?: () => string | undefined };
  if (typeof named.getName === 'function') {
    return named.getName();
  }
  return undefined;
}

/**
 * Whether the declaration is reachable from outside its module.
 *
 * A class member counts as exported when its class is: it is what callers in other modules
 * can reach, which is the property the blast radius actually depends on. A `private` member
 * is not, even inside an exported class.
 */
export function isExported(declaration: Node): boolean {
  const kind = declaration.getKind();

  if (
    kind === SyntaxKind.MethodDeclaration ||
    kind === SyntaxKind.PropertyDeclaration ||
    kind === SyntaxKind.GetAccessor ||
    kind === SyntaxKind.SetAccessor ||
    kind === SyntaxKind.Constructor
  ) {
    const modifiers = declaration as unknown as { hasModifier?: (m: SyntaxKind) => boolean };
    if (modifiers.hasModifier?.(SyntaxKind.PrivateKeyword)) return false;

    const owner = declaration.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
    return owner ? owner.isExported() : false;
  }

  const exportable = declaration as unknown as { isExported?: () => boolean };
  if (typeof exportable.isExported === 'function') return exportable.isExported();

  // A VariableDeclaration's export modifier lives on the statement two levels up.
  const statement = declaration.getFirstAncestorByKind(SyntaxKind.VariableStatement);
  return statement ? statement.isExported() : false;
}

export function symbolIdFor(relativePath: string, name: string): SymbolId {
  return `${relativePath}#${name}`;
}

/** Locates the declaration containing a 1-indexed line, or module scope when there is none. */
export function locateAtLine(
  file: TsSourceFile,
  relativePath: string,
  line: number,
): LocatedSymbol | undefined {
  const lineCount = file.getEndLineNumber();
  if (line < 1 || line > lineCount) return undefined;

  const position = file.compilerNode.getPositionOfLineAndCharacter(line - 1, 0);
  const node = file.getDescendantAtPos(position);

  const declaration = node ? enclosingDeclaration(node) : undefined;
  if (!declaration) {
    return {
      id: symbolIdFor(relativePath, MODULE_SCOPE),
      name: MODULE_SCOPE,
      kind: 'unknown',
      file: relativePath,
      line: 1,
      exported: true,
    };
  }

  const name = qualifiedName(declaration);
  if (!name) return undefined;

  const nameNode = (
    declaration as unknown as { getNameNode?: () => Node | undefined }
  ).getNameNode?.();

  return {
    id: symbolIdFor(relativePath, name),
    name,
    kind: KIND_NAMES[declaration.getKind()] ?? 'unknown',
    file: relativePath,
    line: declaration.getStartLineNumber(),
    exported: isExported(declaration),
    nameNode,
    declaration,
  };
}
