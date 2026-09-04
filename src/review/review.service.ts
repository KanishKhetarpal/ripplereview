import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppConfigService } from '../config/app-config.service';
import { ContextAssemblerService } from '../context/context-assembler.service';
import { enforceGrounding } from '../core/grounding';
import { ChangeImpact } from '../core/types/change-impact';
import { ReviewContext } from '../core/types/evidence';
import { ReviewResult } from '../core/types/review-result';
import { GitRepoService } from '../ingest/git-repo.service';
import { RunStoreService } from '../db/run-store.service';
import { LlmService } from '../llm/llm.service';
import { DEMO_IMPACT, buildDemoContext } from './demo-fixture';
import { ImpactService } from './impact.service';
import { buildSystemPrompt, buildUserPrompt } from './prompt/review-prompt';

export interface ReviewRequest {
  repoPath: string;
  baseRef: string;
  headRef: string;
  /** Skip the graph engine entirely — the baseline the eval harness measures against. */
  diffOnly?: boolean;
  maxHops?: number;
}

@Injectable()
export class ReviewService {
  private readonly logger = new Logger(ReviewService.name);

  constructor(
    private readonly llm: LlmService,
    private readonly config: AppConfigService,
    private readonly impacts: ImpactService,
    private readonly assembler: ContextAssemblerService,
    private readonly git: GitRepoService,
    private readonly runs: RunStoreService,
  ) {}

  /**
   * The whole pipeline: ingest, graph, assemble, review, ground.
   *
   * `diffOnly` is the eval baseline and takes the same path from the assembler onwards —
   * same prompt, same budget, same parser, same grounding. The two arms differ in exactly
   * one thing, the evidence block, which is what makes the Phase 3 comparison mean
   * anything at all.
   */
  async run(request: ReviewRequest): Promise<ReviewResult> {
    const startedAt = Date.now();
    const system = buildSystemPrompt();

    const { context, impact } = request.diffOnly
      ? await this.diffOnlyContext(request, system)
      : await this.groundedContext(request, system);

    const completion = await this.llm.reviewStructured(system, buildUserPrompt(context));
    const grounding = enforceGrounding(completion.findings, context.evidence);

    if (grounding.rejected.length > 0) {
      this.logger.warn(
        `${grounding.rejected.length} finding(s) dropped as ungrounded: ` +
          grounding.rejected.map((r) => r.reason).join(', '),
      );
    }

    const result: ReviewResult = {
      runId: randomUUID(),
      createdAt: new Date().toISOString(),
      repo: {
        root: context.meta.repoRoot,
        baseRef: context.meta.baseRef,
        headRef: context.meta.headRef,
      },
      graphGrounded: context.meta.graphGrounded,
      findings: grounding.kept,
      rejected: grounding.rejected,
      evidence: context.evidence,
      impact,
      llm: {
        provider: completion.provider,
        model: completion.model,
        usage: completion.usage,
        latencyMs: completion.totalLatencyMs,
        attempts: completion.attempts,
      },
      totalDurationMs: Date.now() - startedAt,
    };

    // Filed if a database is configured, and never at the cost of the review: a storage
    // failure has already been paid for in graph analysis and model tokens, and losing
    // the result over it would be the worse outcome.
    await this.runs.save(result);

    return result;
  }

  private async groundedContext(
    request: ReviewRequest,
    system: string,
  ): Promise<{ context: ReviewContext; impact: ChangeImpact }> {
    const analysis = await this.impacts.analyse({
      repoPath: request.repoPath,
      baseRef: request.baseRef,
      headRef: request.headRef,
      maxHops: request.maxHops,
    });

    const context = this.assembler.assemble(analysis.impact, analysis.changeSet.rawDiff, {
      maxTokens: this.config.contextTokenBudget,
      reserveForResponse: this.config.maxOutputTokens,
      systemPromptTokens: this.assembler.countTokens(system),
      repoRoot: analysis.impact.repo.root,
      project: analysis.project,
      changedDeclarations: analysis.changedDeclarations,
    });

    return { context, impact: analysis.impact };
  }

  /**
   * The baseline: the same diff, no graph.
   *
   * The graph engine is not run at all — not run and then discarded. Timing and cost are
   * part of what the eval reports, and a baseline that silently paid for the analysis it
   * claims not to use would make the comparison dishonest in our favour.
   */
  private async diffOnlyContext(
    request: ReviewRequest,
    system: string,
  ): Promise<{ context: ReviewContext; impact: ChangeImpact | null }> {
    const changeSet = await this.git.changeSet(request.repoPath, request.baseRef, request.headRef);

    const context = this.assembler.assembleDiffOnly(
      changeSet.rawDiff,
      request.baseRef,
      request.headRef,
      {
        maxTokens: this.config.contextTokenBudget,
        reserveForResponse: this.config.maxOutputTokens,
        systemPromptTokens: this.assembler.countTokens(system),
        repoRoot: request.repoPath,
      },
    );

    return { context, impact: null };
  }

  /** Runs the pipeline over a fixed, clearly-labelled fixture change. */
  async runDemo(): Promise<ReviewResult> {
    const startedAt = Date.now();
    const context = buildDemoContext(this.config.contextTokenBudget);

    const completion = await this.llm.reviewStructured(
      buildSystemPrompt(),
      buildUserPrompt(context),
    );
    const grounding = enforceGrounding(completion.findings, context.evidence);

    return {
      runId: randomUUID(),
      createdAt: new Date().toISOString(),
      repo: {
        root: context.meta.repoRoot,
        baseRef: context.meta.baseRef,
        headRef: context.meta.headRef,
      },
      graphGrounded: context.meta.graphGrounded,
      findings: grounding.kept,
      rejected: grounding.rejected,
      evidence: context.evidence,
      impact: DEMO_IMPACT,
      llm: {
        provider: completion.provider,
        model: completion.model,
        usage: completion.usage,
        latencyMs: completion.totalLatencyMs,
        attempts: completion.attempts,
      },
      totalDurationMs: Date.now() - startedAt,
    };
  }
}
