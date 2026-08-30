export interface SourceFile {
  /** Absolute path on disk. */
  absolutePath: string;
  /** Repo-relative POSIX path — the id used everywhere else in the pipeline. */
  relativePath: string;
}
