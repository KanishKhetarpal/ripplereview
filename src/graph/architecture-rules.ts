import { LayerViolation } from '../core/types/change-impact';
import { ModuleEdge, ModuleGraph } from './interfaces/module-graph.interface';

export interface ArchitectureRule {
  /** The rule as written, quoted back in the finding so it is recognisable. */
  source: string;
  from: RegExp;
  to: RegExp;
}

export class RuleSyntaxError extends Error {
  constructor(line: number, text: string, reason: string) {
    super(`.ripplereview.rules line ${line}: ${reason} — "${text}"`);
    this.name = 'RuleSyntaxError';
  }
}

/**
 * Parses the architecture rules file.
 *
 * One directive, deliberately:
 *
 *     # a domain module must not reach into infrastructure
 *     deny src/domain/** -> src/infrastructure/**
 *
 * Layering is expressible as a set of denials, and a richer language (layer definitions,
 * allow-lists, precedence between rules) is a language the user then has to debug. If a
 * rule does not fire, the reason should be visible in the one line that wrote it.
 *
 * A malformed line is an error, not a skip: a rule silently ignored is a rule the author
 * believes is protecting them.
 */
export function parseRules(text: string): ArchitectureRule[] {
  const rules: ArchitectureRule[] = [];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    if (!line.startsWith('deny ')) {
      throw new RuleSyntaxError(i + 1, line, 'unknown directive (expected "deny")');
    }

    const body = line.slice('deny '.length);
    const parts = body.split('->');
    if (parts.length !== 2) {
      throw new RuleSyntaxError(i + 1, line, 'expected "deny <from-glob> -> <to-glob>"');
    }

    const from = parts[0].trim();
    const to = parts[1].trim();
    if (from === '' || to === '') {
      throw new RuleSyntaxError(i + 1, line, 'both sides of "->" must be a glob');
    }

    rules.push({ source: line, from: globToRegExp(from), to: globToRegExp(to) });
  }

  return rules;
}

/**
 * A minimal glob: `**` crosses directory separators, `*` does not, `?` is one character.
 *
 * Written rather than pulled in, because the whole grammar is three tokens and the
 * alternative is a dependency whose extra features (brace expansion, extglob, negation)
 * would all become part of this file format's contract by accident.
 */
export function globToRegExp(glob: string): RegExp {
  let pattern = '';

  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];

    if (char === '*') {
      if (glob[i + 1] === '*') {
        // `**/` should also match zero directories, so `src/**/x.ts` matches `src/x.ts`.
        if (glob[i + 2] === '/') {
          pattern += '(?:.*/)?';
          i += 2;
          continue;
        }
        pattern += '.*';
        i += 1;
        continue;
      }
      pattern += '[^/]*';
      continue;
    }

    if (char === '?') {
      pattern += '[^/]';
      continue;
    }

    pattern += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }

  return new RegExp(`^${pattern}$`);
}

/** Every edge in the graph that a rule forbids. */
export function findViolations(
  graph: ModuleGraph,
  rules: ArchitectureRule[],
  baseEdges: ReadonlySet<string>,
): LayerViolation[] {
  const violations: LayerViolation[] = [];

  for (const edge of graph.edges) {
    for (const rule of rules) {
      if (!rule.from.test(edge.from)) continue;
      if (!rule.to.test(edge.to)) continue;

      violations.push({
        rule: rule.source,
        fromModule: edge.from,
        toModule: edge.to,
        specifier: edge.specifier,
        introducedByChange: !baseEdges.has(edgeKey(edge)),
      });
    }
  }

  return violations;
}

export function edgeKey(edge: ModuleEdge): string {
  return `${edge.from} -> ${edge.to}`;
}
