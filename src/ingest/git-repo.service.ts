import { Injectable, Logger } from '@nestjs/common';
import { simpleGit, SimpleGit } from 'simple-git';
import { ChangeSet } from './interfaces/change-set.interface';
import { parseUnifiedDiff } from './diff-parser';

export class NotAGitRepositoryError extends Error {
  constructor(path: string) {
    super(`${path} is not a git repository (or git is not on PATH)`);
    this.name = 'NotAGitRepositoryError';
  }
}

export class UnknownRefError extends Error {
  constructor(ref: string, path: string) {
    super(`ref "${ref}" does not exist in ${path}`);
    this.name = 'UnknownRefError';
  }
}

@Injectable()
export class GitRepoService {
  private readonly logger = new Logger(GitRepoService.name);

  private client(repoPath: string): SimpleGit {
    return simpleGit({ baseDir: repoPath, maxConcurrentProcesses: 4 });
  }

  async assertRepository(repoPath: string): Promise<void> {
    let isRepo: boolean;
    try {
      isRepo = await this.client(repoPath).checkIsRepo();
    } catch {
      throw new NotAGitRepositoryError(repoPath);
    }
    if (!isRepo) throw new NotAGitRepositoryError(repoPath);
  }

  /** Resolves a ref to its commit sha, so a run records what it actually reviewed. */
  async resolveRef(repoPath: string, ref: string): Promise<string> {
    try {
      const sha = await this.client(repoPath).revparse([ref]);
      return sha.trim();
    } catch {
      throw new UnknownRefError(ref, repoPath);
    }
  }

  /**
   * The change between two refs.
   *
   * `--find-renames` is on because a renamed file otherwise reads as a whole-file delete
   * plus a whole-file add, which turns every symbol in it into a changed symbol and floods
   * the blast radius with the entire file's call sites.
   *
   * Two dots, not three: `base..head` is the literal difference between the two trees,
   * which is what a reviewer looking at a working branch means. Three dots would diff
   * against the merge base and silently hide a change that base picked up after the branch
   * was cut.
   */
  async changeSet(repoPath: string, baseRef: string, headRef: string): Promise<ChangeSet> {
    await this.assertRepository(repoPath);
    await this.resolveRef(repoPath, baseRef);
    await this.resolveRef(repoPath, headRef);

    const rawDiff = await this.client(repoPath).raw([
      'diff',
      '--find-renames',
      '--no-color',
      '--no-ext-diff',
      `${baseRef}..${headRef}`,
    ]);

    const files = parseUnifiedDiff(rawDiff);
    this.logger.debug(`${baseRef}..${headRef}: ${files.length} changed file(s)`);

    return { baseRef, headRef, files, rawDiff };
  }

  /** True when the working tree has no uncommitted changes to tracked files. */
  async isClean(repoPath: string): Promise<boolean> {
    const status = await this.client(repoPath).status();
    return status.isClean();
  }

  /**
   * A file's content at a ref, or null when it does not exist there.
   *
   * Null is a real answer, not an error: a file added on the branch has no base version,
   * and the base module graph is built by asking exactly this question.
   */
  async fileAtRef(repoPath: string, ref: string, path: string): Promise<string | null> {
    try {
      return await this.client(repoPath).show([`${ref}:${path}`]);
    } catch {
      return null;
    }
  }
}
