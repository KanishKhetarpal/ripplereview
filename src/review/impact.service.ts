import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { ChangeImpact } from '../core/types/change-impact';
import { ChangeImpactService, ImpactAnalysis } from '../graph/change-impact.service';
import { GitRepoService } from '../ingest/git-repo.service';
import { ChangeSet } from '../ingest/interfaces/change-set.interface';

export interface ImpactRequest {
  repoPath: string;
  baseRef: string;
  headRef: string;
  /** Overrides BLAST_RADIUS_MAX_HOPS for one run. */
  maxHops?: number;
}

/**
 * The graph engine on its own, with no model involved.
 *
 * Everything it returns is deterministic and reproducible, which is the point: these are
 * the facts the reviewer is later allowed to cite. Being able to run this half alone is
 * also what makes the Phase 3 comparison honest — the graph arm and the diff-only arm
 * differ in exactly this output and nothing else.
 */
@Injectable()
export class ImpactService {
  private readonly logger = new Logger(ImpactService.name);

  constructor(
    private readonly git: GitRepoService,
    private readonly impacts: ChangeImpactService,
    private readonly config: AppConfigService,
  ) {}

  async compute(request: ImpactRequest): Promise<ChangeImpact> {
    return (await this.analyse(request)).impact;
  }

  /**
   * The impact plus the change set and the loaded project behind it.
   *
   * The reviewer needs all three: the facts to cite, the raw diff to show the model, and
   * the project to quote type definitions from. Returning them together is what stops the
   * review path parsing the whole repository a second time — measured at 741ms and 160MB
   * on a 677-file repo, for something this call already holds.
   */
  async analyse(request: ImpactRequest): Promise<ImpactAnalysis & { changeSet: ChangeSet }> {
    await this.assertHeadIsCheckedOut(request);

    const changeSet = await this.git.changeSet(request.repoPath, request.baseRef, request.headRef);

    const analysis = await this.impacts.analyse(changeSet, {
      repoPath: request.repoPath,
      maxHops: request.maxHops ?? this.config.blastRadiusMaxHops,
    });

    return { ...analysis, changeSet };
  }

  /**
   * The graph is built from the files on disk, so the head ref must be what is checked out.
   *
   * Asking for `--head HEAD~4` used to be accepted and quietly analysed the working tree
   * instead: the diff came from the requested range, the symbols and references came from
   * a different revision, and the line numbers in one were resolved against the other. The
   * output looked entirely normal. Refusing is the only honest answer until the engine can
   * materialise an arbitrary revision, which is a worktree checkout and its own decision.
   */
  private async assertHeadIsCheckedOut(request: ImpactRequest): Promise<void> {
    const [head, requested] = await Promise.all([
      this.git.resolveRef(request.repoPath, 'HEAD'),
      this.git.resolveRef(request.repoPath, request.headRef),
    ]);

    if (head !== requested) {
      throw new HeadNotCheckedOutError(request.headRef, head);
    }

    if (!(await this.git.isClean(request.repoPath))) {
      // Not fatal: the diff is against the commit, the parse sees the edits. Worth saying
      // out loud, because the two then describe slightly different code.
      this.logger.warn(
        'the working tree has uncommitted changes; the diff is computed from commits but ' +
          'the graph is parsed from the files on disk, so the two may disagree',
      );
    }
  }
}

export class HeadNotCheckedOutError extends Error {
  constructor(requestedRef: string, headSha: string) {
    super(
      `--head ${requestedRef} is not the checked-out revision (HEAD is ${headSha.slice(0, 8)}). ` +
        'The graph is built from the files on disk, so analysing another revision would ' +
        `resolve the diff's line numbers against the wrong code. Check out ${requestedRef} first.`,
    );
    this.name = 'HeadNotCheckedOutError';
  }
}
