/** How a file changed between two refs. */
export type FileChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

/** One `@@` hunk. Line numbers are 1-indexed; a count of 0 means "no lines on that side". */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /**
   * The new-side lines this hunk actually changed — NOT its whole span, which also covers
   * the surrounding context lines. Using the span attributes an edit to any declaration
   * within three lines of it.
   */
  changedNewLines: number[];
}

export interface ChangedFile {
  /** Repo-relative POSIX path at HEAD. For a delete, the path it had at base. */
  path: string;
  /** Set only for a rename: the path at base. */
  previousPath?: string;
  status: FileChangeStatus;
  hunks: DiffHunk[];
}

export interface ChangeSet {
  baseRef: string;
  headRef: string;
  files: ChangedFile[];
  /** The raw unified diff, which the reviewer always sees in full. */
  rawDiff: string;
}
