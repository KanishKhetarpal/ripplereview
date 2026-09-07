import { Node, Project, SyntaxKind } from 'ts-morph';
import { relative, sep } from 'node:path';

/**
 * One comparable piece of logic: a function, method, accessor or constructor with a body.
 *
 * A function is the unit rather than a file or a statement range because it is the unit
 * people actually copy. A file-level comparison says "these two files are similar", which
 * nobody can act on; a statement-level one fires on every `if (!x) return;`.
 */
export interface FunctionUnit {
  /** `src/pricing/price.service.ts#PriceService.total@42` — unique per location. */
  id: string;
  /** Repo-relative POSIX path. */
  file: string;
  /** Qualified where it helps: `PriceService.total`, not a bare `total`. */
  name: string;
  line: number;
  endLine: number;
  /**
   * The normalised token stream. This, not the source text, is what gets fingerprinted.
   */
  tokens: string[];
}

const FUNCTION_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
  SyntaxKind.Constructor,
]);

/**
 * Below this, "duplication" is not a defect.
 *
 * Roughly eight to twelve lines of real code. A one-line getter, a two-line wrapper and a
 * bare re-export are structurally identical to every other one in the repository, and
 * saying so on every review would be noise that trains people to ignore the tool.
 *
 * Measured on two repositories: dropping the gate to 0 adds hundreds of matches, all of
 * them pairs of trivial accessors.
 */
export const MIN_UNIT_TOKENS = 40;

/**
 * Normalises a function body to a token stream that survives renaming.
 *
 * Local names and literal values are abstracted, so a copy-pasted function with every
 * variable renamed produces the same stream. Called functions and accessed property names
 * are KEPT, which is the deliberate half of the decision: two functions with an identical
 * shape that call different APIs are not the same logic, and abstracting the calls away
 * makes `validateEmail` and `validatePhone` indistinguishable.
 *
 * Measured cost of keeping them (probe, two repositories): a rename that also renames a
 * local which is then CALLED moves the fingerprint, so recall on a synthetic
 * rename-everything clone drops from ~100% to 74-92%. Measured benefit: roughly half as
 * many unrelated pairs cross the threshold. Real copy-paste keeps its library calls, so
 * the case this loses on is rarer than the case it wins on.
 */
export function normaliseTokens(body: Node): string[] {
  const tokens: string[] = [];

  body.forEachDescendant((node) => {
    const kind = node.getKind();

    if (kind === SyntaxKind.Identifier) {
      tokens.push(isSemanticName(node) ? `N:${node.getText()}` : 'ID');
      return;
    }

    // Literal VALUES carry no structure — a threshold of 10 and a threshold of 500 are
    // the same logic. Their TYPE is kept, because swapping a string for a number is not.
    if (kind === SyntaxKind.StringLiteral || kind === SyntaxKind.NoSubstitutionTemplateLiteral) {
      tokens.push('STR');
      return;
    }
    if (kind === SyntaxKind.NumericLiteral) {
      tokens.push('NUM');
      return;
    }

    tokens.push(SyntaxKind[kind]);
  });

  return tokens;
}

/** A call target or a property name: part of what the code DOES, so it is kept verbatim. */
function isSemanticName(node: Node): boolean {
  const parent = node.getParent();
  if (!parent) return false;

  if (Node.isCallExpression(parent)) return parent.getExpression() === node;
  if (Node.isPropertyAccessExpression(parent)) return parent.getNameNode() === node;
  return false;
}

/**
 * Every function unit in a loaded project, in file order.
 *
 * Reuses the project the graph engine already loaded. Parsing the repository a second time
 * for this would cost as much again as the whole analysis — measured at 741ms and 160MB on
 * a 677-file repository.
 */
export function extractUnits(project: Project, repoRoot: string): FunctionUnit[] {
  const units: FunctionUnit[] = [];

  for (const file of project.getSourceFiles()) {
    const absolutePath = file.getFilePath();
    if (absolutePath.endsWith('.d.ts') || absolutePath.includes('/node_modules/')) continue;

    const relativePath = relative(repoRoot, absolutePath).split(sep).join('/');
    if (relativePath.startsWith('..') || relativePath === '') continue;

    file.forEachDescendant((node) => {
      if (!FUNCTION_KINDS.has(node.getKind())) return;

      const body = getBody(node);
      if (!body) return;

      const tokens = normaliseTokens(body);
      if (tokens.length < MIN_UNIT_TOKENS) return;

      const line = node.getStartLineNumber();
      const name = qualifiedName(node);

      units.push({
        id: `${relativePath}#${name}@${line}`,
        file: relativePath,
        name,
        line,
        endLine: node.getEndLineNumber(),
        tokens,
      });
    });
  }

  return units;
}

function getBody(node: Node): Node | undefined {
  return Node.isBodyable(node) || Node.isBodied(node) ? node.getBody() : undefined;
}

/**
 * `PriceService.total` for a method, `total` for a free function.
 *
 * An arrow function assigned to a variable takes the variable's name — `const total = () =>`
 * is a named function to every reader, and reporting `<anonymous>` for it would make the
 * finding unactionable.
 */
function qualifiedName(node: Node): string {
  const own = Node.isConstructorDeclaration(node)
    ? 'constructor'
    : ((Node.hasName(node) ? node.getName() : undefined) ?? inferredName(node));

  const owner = node.getFirstAncestor(
    (ancestor) => Node.isClassDeclaration(ancestor) || Node.isClassExpression(ancestor),
  );
  const ownerName = owner && Node.hasName(owner) ? owner.getName() : undefined;

  return ownerName ? `${ownerName}.${own}` : own;
}

function inferredName(node: Node): string {
  const parent = node.getParent();
  if (parent && Node.isVariableDeclaration(parent)) return parent.getName();
  if (parent && Node.isPropertyAssignment(parent)) return parent.getName();
  if (parent && Node.isPropertyDeclaration(parent)) return parent.getName();
  return '<anonymous>';
}

export { FUNCTION_KINDS };
