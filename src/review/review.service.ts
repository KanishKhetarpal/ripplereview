import { Injectable, NotImplementedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppConfigService } from '../config/app-config.service';
import { enforceGrounding } from '../core/grounding';
import { ReviewContext } from '../core/types/evidence';
import { ReviewResult } from '../core/types/review-result';
import { LlmService } from '../llm/llm.service';
import { DEMO_IMPACT, buildDemoContext } from './demo-fixture';

export interface ReviewRequest {
  repoPath: string;
  baseRef: string;
  headRef: string;
  /** Skip the graph engine entirely — the baseline the eval harness measures against. */
  diffOnly?: boolean;
}

/**
 * Phase 0 wires the second half of the pipeline: a review context goes to the model, the
 * response is validated and grounded, and a `ReviewResult` comes back. The first half —
 * ingest, graph engine, context assembler — is not built yet, so `run()` refuses rather
 * than fabricating an empty impact and calling it a review.
 */
@Injectable()
export class ReviewService {
  constructor(
    private readonly llm: LlmService,
    private readonly config: AppConfigService,
  ) {}

  run(_request: ReviewRequest): Promise<ReviewResult> {
    throw new NotImplementedException(
      'Reviewing a real repository needs the ingest + graph engine (Phase 1) and the ' +
        'context assembler (Phase 2). Run `ripplereview demo` to exercise the parts that exist.',
    );
  }

  /** Runs the built half of the pipeline over a fixed, clearly-labelled fixture change. */
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

/**
 * A placeholder prompt. The real one — with the grounding contract, category definitions
 * and few-shot calibration — is Phase 2 work; this exists only so the demo has something
 * to send.
 */
export function buildSystemPrompt(): string {
  return [
    'You are a senior code reviewer.',
    'Every structural claim you make MUST cite an evidence id from the EVIDENCE block.',
    'Never assert a call site, dependency or cycle that is not in the evidence.',
    'Reply with only a JSON object of the form {"findings": [...]}.',
  ].join(' ');
}

export function buildUserPrompt(context: ReviewContext): string {
  const evidence = context.evidence
    .map((item) => `[${item.id}] (${item.kind}) ${item.summary}`)
    .join('\n');

  return ['## DIFF', context.diff, '', '## EVIDENCE', evidence].join('\n');
}
