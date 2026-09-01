import { rmSync } from 'node:fs';
import { INestApplicationContext, LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { AppConfigService } from '../src/config/app-config.service';
import { LlmService } from '../src/llm/llm.service';
import { ReviewService } from '../src/review/review.service';
import { CORPUS } from './corpus';
import { matchFindings } from './matcher';
import { ScoredRun, countsFor, crossModuleRecall, ratesFor, summarise } from './metrics';
import { Arm, CorpusCase, RunOutcome } from './types';

export interface EvalOptions {
  /** Runs per arm per case. One run of a non-deterministic model is an anecdote. */
  runs: number;
  /** Restrict to these case names; empty means all of them. */
  only: string[];
  onProgress?: (message: string) => void;
}

export interface CaseReport {
  case: string;
  summary: string;
  defectCount: number;
  arms: Record<Arm, ReturnType<typeof summarise>>;
  /** Every scored run, so the scorecard can show what was actually said. */
  runs: ScoredRun[];
}

export interface EvalReport {
  startedAt: string;
  finishedAt: string;
  provider: string;
  model: string;
  runsPerArm: number;
  cases: CaseReport[];
  overall: Record<Arm, ReturnType<typeof summarise>>;
}

const ARMS: Arm[] = ['grounded', 'diff-only'];

/**
 * Runs both arms over the corpus and scores them.
 *
 * The two arms share one application context, so they are provably the same provider, the
 * same model and the same prompt — the comparison's entire validity rests on nothing
 * differing between them except the evidence block, and constructing them separately is
 * the obvious way for that to quietly stop being true.
 */
export class EvalRunner {
  private app: INestApplicationContext | null = null;

  async run(options: EvalOptions): Promise<EvalReport> {
    const startedAt = new Date().toISOString();
    const progress = options.onProgress ?? ((): void => undefined);

    const logger: LogLevel[] = ['error'];
    this.app = await NestFactory.createApplicationContext(AppModule, {
      logger,
      abortOnError: false,
    });

    const reviews = this.app.get(ReviewService);
    const llm = this.app.get(LlmService);
    const config = this.app.get(AppConfigService);

    const cases = options.only.length
      ? CORPUS.filter((entry) => options.only.includes(entry.name))
      : CORPUS;

    if (cases.length === 0) {
      throw new Error(`no corpus case matched: ${options.only.join(', ')}`);
    }

    const reports: CaseReport[] = [];

    try {
      for (const entry of cases) {
        progress(`case ${entry.name}`);
        reports.push(await this.runCase(entry, reviews, options, progress));
      }
    } finally {
      await this.app.close();
      this.app = null;
    }

    const allRuns = reports.flatMap((report) => report.runs);

    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      provider: llm.providerName,
      model: config.model ?? '(provider default)',
      runsPerArm: options.runs,
      cases: reports,
      overall: {
        grounded: summariseArm('grounded', allRuns),
        'diff-only': summariseArm('diff-only', allRuns),
      },
    };
  }

  private async runCase(
    entry: CorpusCase,
    reviews: ReviewService,
    options: EvalOptions,
    progress: (message: string) => void,
  ): Promise<CaseReport> {
    // Built once and shared by both arms. Nothing in a review mutates the repository, and
    // rebuilding per run would add git cost to a measurement that is about the model.
    const repo = entry.build();
    const scored: ScoredRun[] = [];
    const failures: Record<Arm, number> = { grounded: 0, 'diff-only': 0 };

    try {
      for (const arm of ARMS) {
        for (let run = 1; run <= options.runs; run++) {
          progress(`  ${entry.name} / ${arm} / run ${run}`);
          const outcome = await this.reviewOnce(entry, repo.path, arm, run, reviews);

          if (outcome.error) {
            failures[arm]++;
            continue;
          }

          const match = matchFindings(outcome.findings, entry.defects);
          scored.push({
            outcome,
            match,
            counts: countsFor(match),
            rates: ratesFor(countsFor(match)),
            crossModuleRecall: crossModuleRecall(match, entry.defects),
          });
        }
      }
    } finally {
      rmSync(repo.path, { recursive: true, force: true });
    }

    return {
      case: entry.name,
      summary: entry.summary,
      defectCount: entry.defects.length,
      arms: {
        grounded: summariseArm('grounded', scored, failures.grounded),
        'diff-only': summariseArm('diff-only', scored, failures['diff-only']),
      },
      runs: scored,
    };
  }

  /**
   * One review.
   *
   * A failure is recorded and the run continues. A provider that rate-limits on run 7 of 40
   * should cost one data point, not the whole evaluation — and the count of failures is
   * reported, so a scorecard built mostly from failures cannot look like a clean result.
   */
  private async reviewOnce(
    entry: CorpusCase,
    repoPath: string,
    arm: Arm,
    run: number,
    reviews: ReviewService,
  ): Promise<RunOutcome> {
    const startedAt = Date.now();
    try {
      const result = await reviews.run({
        repoPath,
        baseRef: 'HEAD~1',
        headRef: 'HEAD',
        diffOnly: arm === 'diff-only',
      });

      return {
        case: entry.name,
        arm,
        run,
        // The findings the grounding guard KEPT. A structural claim that cited nothing was
        // never shown to a user, so crediting it here would score the reviewer for output
        // the product suppresses.
        findings: result.findings,
        promptTokens: result.llm.usage.reduce((sum, u) => sum + u.inputTokens, 0),
        completionTokens: result.llm.usage.reduce((sum, u) => sum + u.outputTokens, 0),
        latencyMs: result.llm.latencyMs,
      };
    } catch (error) {
      return {
        case: entry.name,
        arm,
        run,
        findings: [],
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function summariseArm(
  arm: Arm,
  runs: ScoredRun[],
  failures = 0,
): ReturnType<typeof summarise> {
  return summarise(
    arm,
    runs.filter((run) => run.outcome.arm === arm),
    failures,
  );
}
