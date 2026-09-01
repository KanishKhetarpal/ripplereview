import { CATEGORIES, SEVERITIES } from '../../core/types/finding';
import { ReviewContext } from '../../core/types/evidence';
import { renderEvidence } from '../../context/context-assembler.service';
import { schemaHint } from '../../llm/parsing/finding-parser';

/**
 * The system prompt.
 *
 * Two things it must do, and everything in it serves one of them.
 *
 * First, make the model reason about the evidence rather than restate it. A grounded
 * reviewer that only says "E3 shows a cycle" adds nothing over printing E3; the value is
 * in "given E3, this retry loop can now re-enter itself".
 *
 * Second, make ungrounded structural claims unlikely — though never impossible, which is
 * why `enforceGrounding()` also drops them in code. Prompt wording is a preference; the
 * guard is the guarantee. Saying it here as well is cheap and reduces how often the guard
 * has to fire.
 */
export function buildSystemPrompt(): string {
  return [
    'You are a senior engineer reviewing a pull request.',
    '',
    'You are given the diff AND a block of EVIDENCE: facts computed deterministically from',
    "the repository's dependency graph — which symbols the change reaches, how many hops",
    'away, what cycles it creates, what architecture rules it breaks. The evidence is',
    'ground truth. You are not.',
    '',
    'RULES',
    '',
    '1. Every structural claim MUST cite the evidence ids it rests on, in `evidenceRefs`.',
    '   A structural claim is anything about what the change reaches, breaks, or connects:',
    '   call sites, dependencies, cycles, layering. Cite as ["E3"], not in prose.',
    '2. NEVER assert a call site, dependency, cycle or import that is not in the evidence.',
    '   If you suspect one exists but it is not listed, say so as an uncertainty in the',
    '   rationale — do not state it as fact. The evidence may be incomplete; it is never wrong.',
    '3. Reason FROM the evidence to a consequence. Restating an evidence line is not a',
    '   finding. "CheckoutService.confirm calls total()" is a fact; "confirm() still passes',
    '   one argument, so the new discount silently defaults to 0 for every checkout" is a',
    '   finding.',
    '4. A local observation about the diff alone (a null check, a typo, an unhandled error)',
    '   needs no citation. Report it with an empty evidenceRefs array.',
    '5. Do not report style, formatting or import ordering. Assume a linter and formatter',
    '   have already run.',
    '6. Prefer few high-confidence findings to many speculative ones. An empty findings',
    '   array is a valid and useful answer.',
    '',
    'SEVERITY',
    `  Use one of: ${SEVERITIES.join(', ')}.`,
    '  critical — data loss, security hole, or a break that reaches production users',
    '  high     — a caller or contract is broken; the change is wrong as written',
    '  medium   — a real defect in an edge case, or a rule violation with consequences',
    '  low      — worth fixing, no immediate consequence',
    '  info     — an observation the author should know',
    '',
    'CATEGORY',
    `  Use one of: ${CATEGORIES.join(', ')}.`,
    '  cross-module-regression — a distant dependant breaks or silently changes behaviour',
    '  circular-dependency     — the change creates or deepens an import cycle',
    '  architecture            — the change crosses a layer boundary it should not',
    '',
    'OUTPUT',
    '  Reply with ONLY a JSON object. No prose, no markdown fence.',
    `  ${schemaHint()}`,
    '  `line` is a line in the file named by `file`; use 0 if the finding is about the',
    '  change as a whole.',
  ].join('\n');
}

/**
 * The user message: the diff, then the evidence.
 *
 * Evidence goes last on purpose. It is the part the model must actually use, and recency
 * within a prompt is the cheapest lever available for that. The diff comes first because
 * it is what the evidence is *about* — reading the facts before the change they describe
 * makes them noise.
 */
export function buildUserPrompt(context: ReviewContext): string {
  const sections: string[] = [];

  sections.push('## DIFF UNDER REVIEW');
  sections.push(`Base: ${context.meta.baseRef}   Head: ${context.meta.headRef}`);
  sections.push('');
  sections.push(context.diff.trim());
  sections.push('');

  if (context.evidence.length === 0) {
    // The diff-only baseline. Said explicitly so the model does not infer, from an empty
    // evidence block, that the change provably reaches nothing.
    sections.push('## EVIDENCE');
    sections.push(
      'No dependency-graph evidence is available for this change. Do not infer from this ' +
        'that the change is self-contained — it means the analysis was not run. Report only ' +
        'what the diff itself supports, and make no structural claims.',
    );
    return sections.join('\n');
  }

  sections.push(`## EVIDENCE (${context.evidence.length} facts, ranked most important first)`);
  sections.push('Computed from the dependency graph. Cite these ids for every structural claim.');
  sections.push('');
  for (const item of context.evidence) {
    sections.push(renderEvidence(item));
  }

  if (context.budget.droppedItemIds.length > 0) {
    sections.push('');
    sections.push(
      `[${context.budget.droppedItemIds.length} further evidence item(s) did not fit the ` +
        'token budget. The blast radius shown is therefore a lower bound: absence of an ' +
        'impacted site here is not proof that none exists.]',
    );
  }

  return sections.join('\n');
}
