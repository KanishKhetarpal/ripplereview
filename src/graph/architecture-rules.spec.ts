import { describe, expect, it } from 'vitest';
import { RuleSyntaxError, findViolations, globToRegExp, parseRules } from './architecture-rules';
import { ModuleGraph } from './interfaces/module-graph.interface';

describe('globToRegExp', () => {
  const matches = (glob: string, path: string): boolean => globToRegExp(glob).test(path);

  it('matches an exact path', () => {
    expect(matches('src/a.ts', 'src/a.ts')).toBe(true);
    expect(matches('src/a.ts', 'src/b.ts')).toBe(false);
  });

  it('lets * match within one segment only', () => {
    expect(matches('src/*.ts', 'src/a.ts')).toBe(true);
    expect(matches('src/*.ts', 'src/deep/a.ts')).toBe(false);
  });

  it('lets ** cross directory separators', () => {
    expect(matches('src/**', 'src/a/b/c.ts')).toBe(true);
    expect(matches('src/domain/**', 'src/domain/orders/order.ts')).toBe(true);
    expect(matches('src/domain/**', 'src/infra/db.ts')).toBe(false);
  });

  it('lets **/ match zero directories', () => {
    // Otherwise `src/**/*.controller.ts` silently misses a controller directly in src/.
    expect(matches('src/**/*.controller.ts', 'src/a.controller.ts')).toBe(true);
    expect(matches('src/**/*.controller.ts', 'src/api/a.controller.ts')).toBe(true);
  });

  it('treats ? as exactly one non-separator character', () => {
    expect(matches('src/a?.ts', 'src/ab.ts')).toBe(true);
    expect(matches('src/a?.ts', 'src/abc.ts')).toBe(false);
  });

  it('escapes regex metacharacters in a literal path', () => {
    expect(matches('src/a.ts', 'src/aXts')).toBe(false);
    expect(matches('src/(x)/a.ts', 'src/(x)/a.ts')).toBe(true);
  });

  it('anchors both ends', () => {
    expect(matches('src/a.ts', 'other/src/a.ts')).toBe(false);
    expect(matches('src/a.ts', 'src/a.ts.bak')).toBe(false);
  });
});

describe('parseRules', () => {
  it('parses a deny rule', () => {
    const rules = parseRules('deny src/domain/** -> src/infra/**');
    expect(rules).toHaveLength(1);
    expect(rules[0].source).toBe('deny src/domain/** -> src/infra/**');
    expect(rules[0].from.test('src/domain/order.ts')).toBe(true);
    expect(rules[0].to.test('src/infra/db.ts')).toBe(true);
  });

  it('ignores comments and blank lines', () => {
    const rules = parseRules('# a comment\n\n  \ndeny a/** -> b/**\n');
    expect(rules).toHaveLength(1);
  });

  it('parses several rules', () => {
    expect(parseRules('deny a/** -> b/**\ndeny c/** -> d/**')).toHaveLength(2);
  });

  it('rejects an unknown directive rather than ignoring it', () => {
    // A rule silently skipped is a rule its author believes is protecting them.
    expect(() => parseRules('allow a/** -> b/**')).toThrow(RuleSyntaxError);
  });

  it('rejects a rule with no arrow', () => {
    expect(() => parseRules('deny a/**')).toThrow(/expected "deny <from-glob> -> <to-glob>"/);
  });

  it('rejects a rule with an empty side', () => {
    expect(() => parseRules('deny  -> b/**')).toThrow(/both sides/);
  });

  it('names the offending line number', () => {
    expect(() => parseRules('deny a/** -> b/**\nnonsense')).toThrow(/line 2/);
  });
});

describe('findViolations', () => {
  const graph: ModuleGraph = {
    nodes: [
      { id: 'src/domain/order.ts', externalImports: [] },
      { id: 'src/infra/db.ts', externalImports: [] },
      { id: 'src/api/x.ts', externalImports: [] },
    ],
    edges: [
      { from: 'src/domain/order.ts', to: 'src/infra/db.ts', specifier: '../infra/db' },
      { from: 'src/api/x.ts', to: 'src/infra/db.ts', specifier: '../infra/db' },
    ],
  };
  const rules = parseRules('deny src/domain/** -> src/infra/**');

  it('flags only the forbidden edge', () => {
    const violations = findViolations(graph, rules, new Set());
    expect(violations).toHaveLength(1);
    expect(violations[0].fromModule).toBe('src/domain/order.ts');
  });

  it('quotes the rule that forbids it', () => {
    const [violation] = findViolations(graph, rules, new Set());
    expect(violation.rule).toBe('deny src/domain/** -> src/infra/**');
  });

  it('marks an edge absent from base as introduced by the change', () => {
    const [violation] = findViolations(graph, rules, new Set());
    expect(violation.introducedByChange).toBe(true);
  });

  it('marks an edge already present at base as pre-existing', () => {
    const baseEdges = new Set(['src/domain/order.ts -> src/infra/db.ts']);
    const [violation] = findViolations(graph, rules, baseEdges);
    expect(violation.introducedByChange).toBe(false);
  });

  it('finds nothing when there are no rules', () => {
    expect(findViolations(graph, [], new Set())).toEqual([]);
  });

  it('reports one violation per rule when two rules forbid the same edge', () => {
    const two = parseRules('deny src/domain/** -> src/infra/**\ndeny src/** -> src/infra/db.ts');
    expect(findViolations(graph, two, new Set())).toHaveLength(3);
  });
});
