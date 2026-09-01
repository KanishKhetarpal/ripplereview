import { Injectable, Logger } from '@nestjs/common';
import { Node, Project, SyntaxKind } from 'ts-morph';
import { EvidenceItem } from '../core/types/evidence';
import { typeDefinitionEvidence } from './evidence-builder';

export interface TypeExtractionOptions {
  repoRoot: string;
  /** Definitions to collect before stopping. */
  maxDefinitions?: number;
  /** A definition longer than this is skipped: it would crowd out the blast radius. */
  maxCharsPerDefinition?: number;
}

const DEFAULT_MAX_DEFINITIONS = 12;
const DEFAULT_MAX_CHARS = 1500;

/** Declaration kinds worth quoting: they describe a contract the change may have broken. */
const QUOTABLE = new Set<SyntaxKind>([
  SyntaxKind.InterfaceDeclaration,
  SyntaxKind.TypeAliasDeclaration,
  SyntaxKind.EnumDeclaration,
]);

@Injectable()
export class TypeExtractor {
  private readonly logger = new Logger(TypeExtractor.name);

  /**
   * The type and interface definitions the changed code refers to.
   *
   * Without these the model is reasoning about a signature change with no idea what the
   * signature means — it can see `total(items: Item[], discount = 0)` and the call sites,
   * but not what `Item` is. That is exactly the gap a human reviewer closes by opening one
   * more file, and the assembler can close it for free from the graph it already built.
   *
   * Only interfaces, type aliases and enums are quoted. A class definition is usually large
   * and mostly implementation, and its useful part — who calls it — is already in the blast
   * radius.
   */
  extract(
    project: Project,
    declarations: Node[],
    options: TypeExtractionOptions,
  ): Omit<EvidenceItem, 'id'>[] {
    const maxDefinitions = options.maxDefinitions ?? DEFAULT_MAX_DEFINITIONS;
    const maxChars = options.maxCharsPerDefinition ?? DEFAULT_MAX_CHARS;

    const collected = new Map<string, Omit<EvidenceItem, 'id'>>();

    for (const declaration of declarations) {
      if (collected.size >= maxDefinitions) break;

      for (const identifier of this.typeIdentifiers(declaration)) {
        if (collected.size >= maxDefinitions) break;

        let definitions: Node[];
        try {
          definitions = identifier.asKindOrThrow(SyntaxKind.Identifier).getDefinitionNodes();
        } catch (error) {
          this.logger.debug(`type lookup failed for ${identifier.getText()}: ${String(error)}`);
          continue;
        }

        for (const definition of definitions) {
          if (!QUOTABLE.has(definition.getKind())) continue;

          const file = definition.getSourceFile().getFilePath();
          const relativePath = toRelative(file, options.repoRoot);
          // A type from node_modules is not this repository's contract to have broken.
          if (!relativePath) continue;

          const text = definition.getText();
          if (text.length > maxChars) continue;

          const name = (definition as unknown as { getName?: () => string }).getName?.();
          if (!name) continue;

          const key = `${relativePath}#${name}`;
          if (collected.has(key)) continue;

          collected.set(
            key,
            typeDefinitionEvidence(name, relativePath, definition.getStartLineNumber(), text),
          );
        }
      }
    }

    void project;
    return [...collected.values()];
  }

  /**
   * Identifiers appearing in type position within a declaration.
   *
   * Restricted to type positions on purpose: every identifier in a function body is a
   * reference to something, and resolving all of them would quote half the repository.
   */
  private typeIdentifiers(declaration: Node): Node[] {
    const identifiers: Node[] = [];

    for (const reference of declaration.getDescendantsOfKind(SyntaxKind.TypeReference)) {
      const name = reference.getFirstChildByKind(SyntaxKind.Identifier);
      if (name) identifiers.push(name);
    }

    return identifiers;
  }
}

function toRelative(absolutePath: string, repoRoot: string): string | null {
  const root = repoRoot.replace(/\\/g, '/').replace(/\/$/, '');
  const path = absolutePath.replace(/\\/g, '/');
  if (!path.startsWith(`${root}/`)) return null;
  if (path.includes('/node_modules/')) return null;
  return path.slice(root.length + 1);
}
