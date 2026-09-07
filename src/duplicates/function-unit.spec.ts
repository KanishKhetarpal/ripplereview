import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { MIN_UNIT_TOKENS, extractUnits, normaliseTokens } from './function-unit';

/**
 * The normaliser's properties, stated one per test.
 *
 * These are the claims the whole feature rests on — that a rename does not move the
 * fingerprint and that a different call does. Testing them through `extractUnits` alone
 * would only tell us the pipeline runs; testing them here says what it guarantees.
 */
function tokensOf(source: string): string[] {
  const project = new Project({ useInMemoryFileSystem: true });
  const file = project.createSourceFile('/probe.ts', source, { overwrite: true });
  const fn = file.getFunctions()[0];
  const body = fn?.getBody();
  if (!body) throw new Error('the snippet has no function body');
  return normaliseTokens(body);
}

describe('normaliseTokens', () => {
  it('is unchanged by renaming locals and parameters', () => {
    const before = tokensOf(`
      function a(items: number[]): number {
        const total = items.reduce((sum, item) => sum + item, 0);
        return total;
      }
    `);
    const after = tokensOf(`
      function b(records: number[]): number {
        const accumulated = records.reduce((carry, record) => carry + record, 0);
        return accumulated;
      }
    `);

    expect(after).toEqual(before);
  });

  it('is unchanged by different literal VALUES of the same type', () => {
    const before = tokensOf('function a(): number { return 1 + 2; }');
    const after = tokensOf('function b(): number { return 9999 + 12345; }');

    expect(after).toEqual(before);
  });

  it('changes when a literal changes TYPE', () => {
    // Swapping a number for a string is not a rename; it is different code.
    const numeric = tokensOf('function a(): unknown { return 1; }');
    const text = tokensOf("function b(): unknown { return 'one'; }");

    expect(text).not.toEqual(numeric);
  });

  it('changes when the code calls something else', () => {
    // The half of the design that costs recall and buys precision: two functions with an
    // identical skeleton calling different APIs are not the same logic.
    const mapped = tokensOf('function a(xs: number[]) { return xs.map((x) => x + 1); }');
    const filtered = tokensOf('function b(xs: number[]) { return xs.filter((x) => x > 1); }');

    expect(filtered).not.toEqual(mapped);
    expect(mapped).toContain('N:map');
    expect(filtered).toContain('N:filter');
  });

  it('abstracts a local name even when it shadows a method name', () => {
    // `map` here is a variable, not a call target, so it must normalise like any other
    // local — otherwise renaming a variable that happens to share a name with a common
    // method would move the fingerprint.
    const tokens = tokensOf('function a() { const map = 1; return map + map; }');

    expect(tokens).not.toContain('N:map');
  });
});

describe('extractUnits', () => {
  const project = new Project({ useInMemoryFileSystem: true });
  project.createSourceFile(
    '/repo/src/sample.ts',
    `export class Reporter {
      summarise(rows: number[]): string {
        const totals = rows.map((row) => row * 2).filter((row) => row > 0);
        let text = '';
        for (const total of totals) {
          text = text.concat(String(total), ',');
        }
        return text.trim();
      }
    }

    export const buildLabel = (rows: number[]): string => {
      const parts = rows.map((row) => row.toFixed(2));
      const joined = parts.join('|');
      const trimmed = joined.trim();
      return trimmed.length > 0 ? trimmed.toUpperCase() : 'EMPTY';
    };

    export function tiny(value: number): number {
      return value;
    }
    `,
    { overwrite: true },
  );

  const units = extractUnits(project, '/repo');

  it('qualifies a method with its class', () => {
    expect(units.map((unit) => unit.name)).toContain('Reporter.summarise');
  });

  it('names an arrow function after the variable it is assigned to', () => {
    // `<anonymous>` for `const buildLabel = () => {}` would make a finding unactionable:
    // every reader calls that function buildLabel.
    expect(units.map((unit) => unit.name)).toContain('buildLabel');
  });

  it('drops functions below the size gate', () => {
    expect(units.map((unit) => unit.name)).not.toContain('tiny');
    expect(units.every((unit) => unit.tokens.length >= MIN_UNIT_TOKENS)).toBe(true);
  });

  it('records repo-relative POSIX paths and a line range', () => {
    const unit = units.find((candidate) => candidate.name === 'Reporter.summarise');
    expect(unit?.file).toBe('src/sample.ts');
    expect(unit?.id).toContain('src/sample.ts#Reporter.summarise@');
    expect(unit && unit.endLine > unit.line).toBe(true);
  });
});
