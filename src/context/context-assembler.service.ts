import { Inject, Injectable, Logger } from '@nestjs/common';
import { Node, Project } from 'ts-morph';
import { ChangeImpact } from '../core/types/change-impact';
import { EvidenceItem, ReviewContext } from '../core/types/evidence';
import { EvidenceBuilder } from './evidence-builder';
import { TOKEN_COUNTER, TokenCounter } from './token-counter';
import { TypeExtractor } from './type-extractor';

export interface AssembleOptions {
  /** Everything handed to the model must fit inside this. */
  maxTokens: number;
  /** Tokens the model needs for its own reply, reserved out of the budget. */
  reserveForResponse: number;
  /** Tokens the system prompt will occupy. */
  systemPromptTokens: number;
  repoRoot: string;
  /** ts-morph project, for quoting type definitions. Absent on a diff-only run. */
  project?: Project;
  /** Declarations the change touched, for finding the types they refer to. */
  changedDeclarations?: Node[];
}

/**
 * Slack left between the packed total and the real limit.
 *
 * The counter is exact for OpenAI's encoding and an estimate for anything else, and the
 * provider adds its own per-message framing that we never see. Overflowing costs the whole
 * request after the graph engine has already done its work, so a few hundred tokens of
 * headroom is cheap insurance.
 */
const SAFETY_MARGIN_TOKENS = 256;

/**
 * How much of the budget the diff may take before it is truncated.
 *
 * The diff is never dropped — it is the thing under review — but an enormous one must not
 * consume the entire budget and leave no room for the evidence that makes this tool
 * different from a diff-only reviewer. That would silently turn a graph-grounded review
 * into the baseline it is supposed to beat.
 */
const MAX_DIFF_SHARE = 0.6;

@Injectable()
export class ContextAssemblerService {
  private readonly logger = new Logger(ContextAssemblerService.name);

  constructor(
    private readonly evidence: EvidenceBuilder,
    private readonly types: TypeExtractor,
    @Inject(TOKEN_COUNTER) private readonly tokens: TokenCounter,
  ) {}

  /** Exposed so the caller can price the system prompt against the same counter. */
  countTokens(text: string): number {
    return this.tokens.count(text);
  }

  /** Which counter produced the budget figures, recorded on the run. */
  get counterName(): string {
    return this.tokens.name;
  }

  /**
   * Packs the diff and the graph facts into one review context under a token budget.
   *
   * The strategy is deliberately simple and inspectable: rank everything, take in rank
   * order until the budget is gone, record exactly what did not fit. A cleverer packing
   * (bin-packing to maximise item count) would fit more items by preferring small ones,
   * which is the opposite of what matters — one introduced cycle is worth more than nine
   * distant call sites.
   *
   * Anything dropped is listed in `budget.droppedItemIds`. Silent truncation would make a
   * review that saw half the evidence indistinguishable from one that saw all of it.
   */
  assemble(impact: ChangeImpact, diff: string, options: AssembleOptions): ReviewContext {
    const available =
      options.maxTokens -
      options.reserveForResponse -
      options.systemPromptTokens -
      SAFETY_MARGIN_TOKENS;

    if (available <= 0) {
      throw new BudgetTooSmallError(options.maxTokens, options.reserveForResponse);
    }

    const { text: packedDiff, truncated } = this.fitDiff(diff, available);
    let used = this.tokens.count(packedDiff);

    const candidates = this.rankedCandidates(impact, options);
    const kept: EvidenceItem[] = [];
    const dropped: string[] = [];

    let index = 0;
    for (const candidate of candidates) {
      const id = `E${++index}`;
      const cost = this.tokens.count(renderEvidence({ ...candidate, id }));

      if (used + cost > available) {
        dropped.push(id);
        continue;
      }

      kept.push({ ...candidate, id });
      used += cost;
    }

    if (dropped.length > 0) {
      this.logger.warn(
        `${dropped.length} of ${candidates.length} evidence item(s) did not fit the ` +
          `${available}-token budget and were dropped: ${dropped.join(', ')}`,
      );
    }

    return {
      diff: packedDiff,
      evidence: kept,
      budget: { maxTokens: available, usedTokens: used, droppedItemIds: dropped },
      meta: {
        repoRoot: options.repoRoot,
        baseRef: impact.repo.baseRef,
        headRef: impact.repo.headRef,
        graphGrounded: true,
      },
      truncatedDiff: truncated,
    };
  }

  /**
   * The diff-only baseline the eval harness measures against.
   *
   * Same model, same prompt, same budget — no evidence. It is built here rather than by
   * passing an empty impact, so the two arms cannot drift apart: any change to how the diff
   * is fitted applies to both.
   */
  assembleDiffOnly(
    diff: string,
    baseRef: string,
    headRef: string,
    options: AssembleOptions,
  ): ReviewContext {
    const available =
      options.maxTokens -
      options.reserveForResponse -
      options.systemPromptTokens -
      SAFETY_MARGIN_TOKENS;

    if (available <= 0) {
      throw new BudgetTooSmallError(options.maxTokens, options.reserveForResponse);
    }

    const { text, truncated } = this.fitDiff(diff, available);

    return {
      diff: text,
      evidence: [],
      budget: {
        maxTokens: available,
        usedTokens: this.tokens.count(text),
        droppedItemIds: [],
      },
      meta: {
        repoRoot: options.repoRoot,
        baseRef,
        headRef,
        graphGrounded: false,
      },
      truncatedDiff: truncated,
    };
  }

  private rankedCandidates(
    impact: ChangeImpact,
    options: AssembleOptions,
  ): Omit<EvidenceItem, 'id'>[] {
    const graphFacts = this.evidence.build(impact).map(({ id: _id, ...rest }) => rest);

    const typeDefs =
      options.project && options.changedDeclarations?.length
        ? this.types.extract(options.project, options.changedDeclarations, {
            repoRoot: options.repoRoot,
          })
        : [];

    return [...graphFacts, ...typeDefs].sort((a, b) => b.weight - a.weight);
  }

  /**
   * Truncates the diff by whole hunks rather than mid-line.
   *
   * A diff cut in the middle of a hunk shows the model a change it cannot interpret, and a
   * reviewer that reasons about half a function is worse than one that knows it is missing
   * a file. What is dropped is stated in the text, so the model is told rather than left to
   * infer it.
   */
  private fitDiff(diff: string, available: number): { text: string; truncated: boolean } {
    const ceiling = Math.floor(available * MAX_DIFF_SHARE);
    if (this.tokens.count(diff) <= ceiling) return { text: diff, truncated: false };

    const files = splitDiffByFile(diff);
    const kept: string[] = [];
    let used = 0;
    let droppedFiles = 0;

    for (const file of files) {
      const cost = this.tokens.count(file);
      if (used + cost > ceiling) {
        droppedFiles++;
        continue;
      }
      kept.push(file);
      used += cost;
    }

    const notice =
      `\n[RippleReview: ${droppedFiles} changed file(s) omitted from this diff — it did not ` +
      `fit the token budget. Findings must not assume the omitted files are unchanged.]\n`;

    this.logger.warn(`diff truncated: ${droppedFiles} file(s) omitted to fit the budget`);
    return { text: kept.join('') + notice, truncated: true };
  }
}

export class BudgetTooSmallError extends Error {
  constructor(maxTokens: number, reserve: number) {
    super(
      `CONTEXT_TOKEN_BUDGET (${maxTokens}) leaves nothing for the prompt once ${reserve} ` +
        `tokens are reserved for the response and ${SAFETY_MARGIN_TOKENS} for safety. ` +
        'Raise the budget or lower LLM_MAX_OUTPUT_TOKENS.',
    );
    this.name = 'BudgetTooSmallError';
  }
}

/** One line per evidence item, exactly as the prompt will carry it. */
export function renderEvidence(item: EvidenceItem): string {
  const where = item.location
    ? ` ${item.location.file}${item.location.line ? `:${item.location.line}` : ''}`
    : '';
  const detail = item.detail ? `\n${item.detail}` : '';
  return `[${item.id}] (${item.kind})${where} ${item.summary}${detail}`;
}

/** Splits a unified diff into per-file chunks, each still a valid diff on its own. */
export function splitDiffByFile(diff: string): string[] {
  const chunks: string[] = [];
  let current: string[] = [];

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ') && current.length > 0) {
      chunks.push(`${current.join('\n')}\n`);
      current = [];
    }
    current.push(line);
  }

  if (current.length > 0) chunks.push(current.join('\n'));
  return chunks;
}

export { SAFETY_MARGIN_TOKENS, MAX_DIFF_SHARE };
