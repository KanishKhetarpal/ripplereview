import { describe, expect, it } from 'vitest';
import { changedLineNumbers, matchHunkHeader, parseUnifiedDiff } from './diff-parser';

const MODIFY = `diff --git a/src/pricing.ts b/src/pricing.ts
index 1111111..2222222 100644
--- a/src/pricing.ts
+++ b/src/pricing.ts
@@ -37,7 +37,8 @@ export class PriceService {
   constructor() {}

   total(items: Item[]): number {
-    return items.reduce((sum, item) => sum + item.price, 0);
+    const gross = items.reduce((sum, item) => sum + item.price, 0);
+    return gross;
   }

   cheapest(items: Item[]): number {
`;

const ADD = `diff --git a/src/checkout.ts b/src/checkout.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/checkout.ts
@@ -0,0 +1,3 @@
+export const a = 1;
+export const b = 2;
+export const c = 3;
`;

const DELETE = `diff --git a/src/doomed.ts b/src/doomed.ts
deleted file mode 100644
index 4444444..0000000
--- a/src/doomed.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const doomed = true;
-export const gone = 1;
`;

const RENAME = `diff --git a/src/old.ts b/src/new.ts
similarity index 100%
rename from src/old.ts
rename to src/new.ts
`;

const PURE_DELETION = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,6 +9,3 @@ export class Thing {
   keep(): void {}

-  removed(): void {
-    doStuff();
-  }
   alsoKeep(): void {}
`;

describe('matchHunkHeader', () => {
  it('parses both counts', () => {
    expect(matchHunkHeader('@@ -39,7 +42,9 @@')).toMatchObject({
      oldStart: 39,
      oldLines: 7,
      newStart: 42,
      newLines: 9,
    });
  });

  it('treats an omitted count as 1, which git writes for a single-line hunk', () => {
    expect(matchHunkHeader('@@ -12 +12 @@')).toMatchObject({
      oldStart: 12,
      oldLines: 1,
      newStart: 12,
      newLines: 1,
    });
  });

  it('parses a mixed header where only one side omits its count', () => {
    expect(matchHunkHeader('@@ -5 +5,3 @@')).toMatchObject({ oldLines: 1, newLines: 3 });
  });

  it('keeps trailing context after the header', () => {
    expect(matchHunkHeader('@@ -1,2 +1,2 @@ export class Foo {')?.newStart).toBe(1);
  });

  it('ignores a line that is not a hunk header', () => {
    expect(matchHunkHeader('+  const x = 1;')).toBeNull();
    expect(matchHunkHeader('@@ malformed @@')).toBeNull();
  });
});

describe('parseUnifiedDiff', () => {
  it('reports a modification with its hunk', () => {
    const [file] = parseUnifiedDiff(MODIFY);
    expect(file.path).toBe('src/pricing.ts');
    expect(file.status).toBe('modified');
    expect(file.hunks).toHaveLength(1);
  });

  it('reports an addition', () => {
    const [file] = parseUnifiedDiff(ADD);
    expect(file.path).toBe('src/checkout.ts');
    expect(file.status).toBe('added');
  });

  it('reports a deletion', () => {
    const [file] = parseUnifiedDiff(DELETE);
    expect(file.path).toBe('src/doomed.ts');
    expect(file.status).toBe('deleted');
  });

  it('reports a rename with the path it had at base', () => {
    const [file] = parseUnifiedDiff(RENAME);
    expect(file.path).toBe('src/new.ts');
    expect(file.previousPath).toBe('src/old.ts');
    expect(file.status).toBe('renamed');
  });

  it('separates several files in one diff', () => {
    const files = parseUnifiedDiff([MODIFY, ADD, DELETE].join(''));
    expect(files.map((f) => f.path)).toEqual([
      'src/pricing.ts',
      'src/checkout.ts',
      'src/doomed.ts',
    ]);
    expect(files.map((f) => f.status)).toEqual(['modified', 'added', 'deleted']);
  });

  it('does not mistake a diff body line for a file header', () => {
    const withBodyText = `${MODIFY}+// diff --git a/fake.ts b/fake.ts\n`;
    expect(parseUnifiedDiff(withBodyText)).toHaveLength(1);
  });

  it('handles a quoted path, which git uses when a name contains a space', () => {
    const quoted = 'diff --git "a/src/my file.ts" "b/src/my file.ts"\n@@ -1 +1 @@\n+x\n';
    const [file] = parseUnifiedDiff(quoted);
    expect(file.path).toBe('src/my file.ts');
  });

  it('returns nothing for an empty diff', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });
});

describe('changedLineNumbers', () => {
  it('reports only the added lines, never the context around them', () => {
    // The hunk header spans lines 37-44, but only two lines were written. Counting the
    // span attributes the edit to `cheapest`, three lines below, which is how this
    // reached the blast radius on the fixture repository.
    const [file] = parseUnifiedDiff(MODIFY);
    expect(changedLineNumbers(file)).toEqual([40, 41]);
  });

  it('reports every line of a newly added file', () => {
    const [file] = parseUnifiedDiff(ADD);
    expect(changedLineNumbers(file)).toEqual([1, 2, 3]);
  });

  it('keeps a pure deletion attributable to the line it was removed from', () => {
    const [file] = parseUnifiedDiff(PURE_DELETION);
    // Two context lines advance the new-side counter from 9 to 11; the three removed
    // lines all anchor there.
    expect(changedLineNumbers(file)).toEqual([11]);
  });

  it('never reports line 0', () => {
    const topDeletion = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +0,0 @@
-const gone = 1;
-const alsoGone = 2;
`;
    const [file] = parseUnifiedDiff(topDeletion);
    expect(changedLineNumbers(file)).toEqual([1]);
  });

  it('merges two hunks in one file without duplicating a line', () => {
    const twoHunks = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,2 @@
 const keep = 1;
+const added = 2;
@@ -20,2 +20,2 @@
 const other = 1;
+const alsoAdded = 2;
`;
    const [file] = parseUnifiedDiff(twoHunks);
    expect(changedLineNumbers(file)).toEqual([2, 21]);
  });

  it('returns nothing for a file with no hunks, such as a pure rename', () => {
    const [file] = parseUnifiedDiff(RENAME);
    expect(changedLineNumbers(file)).toEqual([]);
  });

  it('ignores the "no newline at end of file" marker', () => {
    const noNewline = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-const a = 1;
+const a = 2;
\\ No newline at end of file
`;
    const [file] = parseUnifiedDiff(noNewline);
    expect(changedLineNumbers(file)).toEqual([1]);
  });
});
