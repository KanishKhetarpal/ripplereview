import { Project, SourceFile } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { LocatedSymbol, MODULE_SCOPE, locateAtLine } from './symbol-locator';

const SOURCE = `import { helper } from './helper';

export interface Item {
  price: number;
}

export class PriceService {
  private rate = 1;

  total(items: Item[]): number {
    const gross = items.length;
    return gross * this.rate;
  }

  private secret(): number {
    return 42;
  }
}

export function standalone(): number {
  return 1;
}

function notExported(): number {
  return 2;
}

export const arrow = (): number => 3;

export type Alias = string;

export enum Colour {
  Red,
}
`;

function file(): SourceFile {
  const project = new Project({ useInMemoryFileSystem: true });
  return project.createSourceFile('/src/pricing.ts', SOURCE);
}

const at = (line: number): LocatedSymbol | undefined =>
  locateAtLine(file(), 'src/pricing.ts', line);

/** 1-indexed line of the first line containing `text`. Hard-coded numbers rot. */
function lineOf(text: string): number {
  const index = SOURCE.split('\n').findIndex((line) => line.includes(text));
  if (index === -1) throw new Error(`fixture has no line containing "${text}"`);
  return index + 1;
}

describe('locateAtLine', () => {
  it('attributes a line inside a method to the method, not the class', () => {
    // Attributing to the class would make the blast radius every use of PriceService.
    const located = at(lineOf('return gross * this.rate'));
    expect(located?.id).toBe('src/pricing.ts#PriceService.total');
    expect(located?.kind).toBe('method');
  });

  it('reports the declaration line, not the changed line', () => {
    expect(at(lineOf('return gross * this.rate'))?.line).toBe(lineOf('total(items: Item[])'));
  });

  it('attributes a top-level function to itself', () => {
    const located = at(lineOf('return 1;'));
    expect(located?.id).toBe('src/pricing.ts#standalone');
    expect(located?.kind).toBe('function');
  });

  it('recognises an interface', () => {
    expect(at(lineOf('price: number;'))?.id).toBe('src/pricing.ts#Item');
    expect(at(lineOf('price: number;'))?.kind).toBe('interface');
  });

  it('recognises a type alias', () => {
    expect(at(lineOf('export type Alias'))?.kind).toBe('type');
  });

  it('recognises an enum', () => {
    expect(at(lineOf('Red,'))?.kind).toBe('enum');
  });

  it('recognises an arrow function assigned to a variable', () => {
    const located = at(lineOf('export const arrow'));
    expect(located?.id).toBe('src/pricing.ts#arrow');
    expect(located?.kind).toBe('variable');
  });

  it('marks an exported declaration as exported', () => {
    expect(at(lineOf('export function standalone'))?.exported).toBe(true);
  });

  it('marks a non-exported declaration as not exported', () => {
    expect(at(lineOf('function notExported'))?.exported).toBe(false);
  });

  it('treats a public method of an exported class as reachable from outside', () => {
    expect(at(lineOf('return gross * this.rate'))?.exported).toBe(true);
  });

  it('treats a private method as unreachable from outside, even in an exported class', () => {
    const located = at(lineOf('return 42;'));
    expect(located?.id).toBe('src/pricing.ts#PriceService.secret');
    expect(located?.exported).toBe(false);
  });

  it('falls back to module scope for a changed import line', () => {
    // Changing an import is a real change with a real blast radius, so it is named
    // rather than dropped.
    const located = at(lineOf('import { helper }'));
    expect(located?.name).toBe(MODULE_SCOPE);
    expect(located?.id).toBe(`src/pricing.ts#${MODULE_SCOPE}`);
  });

  it('returns nothing for a line past the end of the file', () => {
    expect(at(9999)).toBeUndefined();
  });

  it('returns nothing for line 0, which is not a line', () => {
    expect(at(0)).toBeUndefined();
  });

  it('gives a name node for a real declaration, so references can be looked up', () => {
    expect(at(lineOf('return gross * this.rate'))?.nameNode).toBeDefined();
  });

  it('gives no name node for module scope, which cannot be looked up', () => {
    expect(at(lineOf('import { helper }'))?.nameNode).toBeUndefined();
  });

  it('attributes a blank line to the declaration that follows it', () => {
    // Leading trivia belongs to the next token, so a blank line edited just above a
    // function is attributed to that function rather than to module scope.
    const blankBeforeAlias = lineOf('export type Alias') - 1;
    expect(at(blankBeforeAlias)?.id).toBe('src/pricing.ts#Alias');
  });
});

const WITH_LOCALS = `export function outer(): number {
  const localValue = 1;
  const config = {
    nested: 1,
  };
  return localValue + config.nested;
}

export class Holder {
  run(): number {
    const insideMethod = 2;
    return insideMethod;
  }
}

const topLevelConst = 3;

const topConfig = {
  alsoNested: 2,
};

describe('something', () => {
  const insideCallback = 4;
});
`;

describe('locateAtLine and local variables', () => {
  const source = (): SourceFile => {
    const project = new Project({ useInMemoryFileSystem: true });
    return project.createSourceFile('/src/locals.ts', WITH_LOCALS);
  };
  const line = (text: string): number =>
    WITH_LOCALS.split('\n').findIndex((l) => l.includes(text)) + 1;
  const locate = (text: string): LocatedSymbol | undefined =>
    locateAtLine(source(), 'src/locals.ts', line(text));

  it('attributes a local const to its enclosing function, not to itself', () => {
    // A local has no cross-module blast radius, so naming it as a changed symbol both
    // floods the list and spends a reference lookup proving the obvious.
    expect(locate('const localValue')?.id).toBe('src/locals.ts#outer');
  });

  it('attributes a local inside a method to the method', () => {
    expect(locate('const insideMethod')?.id).toBe('src/locals.ts#Holder.run');
  });

  it('still names a module-level const', () => {
    expect(locate('const topLevelConst')?.id).toBe('src/locals.ts#topLevelConst');
  });

  it('attributes a continuation line of a LOCAL object to the enclosing function', () => {
    // A line inside a multi-line initialiser is the only shape whose ancestor chain
    // actually contains a VariableDeclaration — at column 0 of a one-line declaration the
    // chain runs ConstKeyword -> VariableDeclarationList -> VariableStatement and skips it
    // entirely. Probed, not assumed.
    expect(locate('nested: 1,')?.id).toBe('src/locals.ts#outer');
  });

  it('attributes a continuation line of a TOP-LEVEL object to that variable', () => {
    expect(locate('alsoNested: 2,')?.id).toBe('src/locals.ts#topConfig');
  });

  it('attributes a local inside an anonymous callback to module scope', () => {
    // There is no named declaration between it and the file, and inventing one would be
    // a symbol nothing can reference.
    expect(locate('const insideCallback')?.name).toBe(MODULE_SCOPE);
  });
});
