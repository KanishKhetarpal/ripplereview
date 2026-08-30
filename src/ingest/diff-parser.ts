import { ChangedFile, DiffHunk, FileChangeStatus } from './interfaces/change-set.interface';

/**
 * Parses a unified diff into per-file changed line ranges.
 *
 * Changed LINES are not the deliverable — changed SYMBOLS are, and those come from mapping
 * these lines onto declarations in the parsed file. So this parser has to be exact about
 * two things: which file, and which lines on the new side actually changed.
 *
 * "Actually changed" is the subtle half. A hunk header spans its CONTEXT lines too — three
 * either side by default — so treating the header's range as the change attributes the edit
 * to whatever declarations happen to sit within three lines of it. Measured on the fixture
 * repository: editing `PriceService.total` reported the untouched `PriceService.cheapest`
 * as changed, and its callers then entered the blast radius. The hunk BODY is therefore
 * walked line by line, and only `+` lines count.
 */
export function parseUnifiedDiff(diff: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  const lines = diff.split(/\r?\n/);

  let current: ChangedFile | null = null;
  let hunk: DiffHunk | null = null;
  let newLine = 0;

  const closeHunk = (): void => {
    if (current && hunk) current.hunks.push(hunk);
    hunk = null;
  };

  for (const line of lines) {
    const header = matchFileHeader(line);
    if (header) {
      closeHunk();
      if (current) files.push(current);
      current = { path: header.newPath, status: 'modified', hunks: [] };
      if (header.oldPath !== header.newPath) {
        current.previousPath = header.oldPath;
        current.status = 'renamed';
      }
      continue;
    }

    if (!current) continue;

    const hunkHeader = matchHunkHeader(line);
    if (hunkHeader) {
      closeHunk();
      hunk = hunkHeader;
      newLine = hunkHeader.newStart;
      continue;
    }

    if (!hunk) {
      const status = matchStatusLine(line);
      if (status) current.status = status;
      continue;
    }

    // Inside a hunk body.
    if (line.startsWith('+')) {
      hunk.changedNewLines.push(newLine);
      newLine++;
      continue;
    }
    if (line.startsWith('-')) {
      // A removal occupies no line on the new side. The line it would have been at is
      // recorded so the deletion stays attributable to the symbol that contained it —
      // otherwise a change that only deletes code has no changed symbol at all.
      hunk.changedNewLines.push(Math.max(1, newLine));
      continue;
    }
    if (line.startsWith('\\')) {
      // "\ No newline at end of file" — metadata, not content.
      continue;
    }
    if (line.startsWith(' ') || line === '') {
      newLine++;
      continue;
    }

    // Anything else ends the hunk: the next `diff --git`, or trailing output.
    closeHunk();
  }

  closeHunk();
  if (current) files.push(current);
  return files;
}

/** `diff --git a/src/x.ts b/src/x.ts` */
function matchFileHeader(line: string): { oldPath: string; newPath: string } | null {
  if (!line.startsWith('diff --git ')) return null;

  const rest = line.slice('diff --git '.length);

  // Quoted paths appear when a name contains a space or a non-ASCII byte.
  const quoted = rest.match(/^"(.+)" "(.+)"$/);
  if (quoted) {
    return { oldPath: stripPrefix(quoted[1]), newPath: stripPrefix(quoted[2]) };
  }

  const match = rest.match(/^a\/(.*) b\/(.*)$/);
  if (!match) return null;
  return { oldPath: match[1], newPath: match[2] };
}

function stripPrefix(path: string): string {
  return path.replace(/^[ab]\//, '');
}

function matchStatusLine(line: string): FileChangeStatus | null {
  if (line.startsWith('new file mode')) return 'added';
  if (line.startsWith('deleted file mode')) return 'deleted';
  if (line.startsWith('rename from') || line.startsWith('rename to')) return 'renamed';
  return null;
}

/**
 * `@@ -12,7 +12,9 @@ optional context`
 *
 * The count is omitted when it is 1 (`@@ -12 +12 @@`), which a naive `split(',')` turns
 * into NaN and silently drops.
 */
export function matchHunkHeader(line: string): DiffHunk | null {
  const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!match) return null;

  return {
    oldStart: Number(match[1]),
    oldLines: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newLines: match[4] === undefined ? 1 : Number(match[4]),
    changedNewLines: [],
  };
}

/** The 1-indexed new-side lines this file actually changed, deduplicated and ordered. */
export function changedLineNumbers(file: ChangedFile): number[] {
  const lines = new Set<number>();

  for (const hunk of file.hunks) {
    for (const line of hunk.changedNewLines) {
      lines.add(line);
    }
  }

  return [...lines].sort((a, b) => a - b);
}
