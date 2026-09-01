/**
 * Evidence is the serialized, citable form of `ChangeImpact` that the model actually sees.
 * Every item carries a short id (`E1`, `E2`, ...) and a finding must cite the ids it relied
 * on, so a structural claim can be traced back to a deterministic fact.
 */

export type EvidenceKind =
  | 'diff-hunk'
  | 'blast-radius'
  | 'call-site'
  | 'type-definition'
  | 'cycle'
  | 'layer-violation'
  | 'instability';

export interface EvidenceLocation {
  /** Repo-relative POSIX path. */
  file: string;
  line?: number;
}

export interface EvidenceItem {
  /** Short citation handle, unique within one review context. */
  id: string;
  kind: EvidenceKind;
  /** One line the model can read without opening `detail`. */
  summary: string;
  /** Source excerpt or structured detail. Omitted when the summary is the whole fact. */
  detail?: string;
  location?: EvidenceLocation;
  /**
   * Ranking weight used by the context assembler when the token budget is tight.
   * Higher survives. Set by the assembler, not by the model.
   */
  weight: number;
}

export interface ContextBudget {
  maxTokens: number;
  usedTokens: number;
  /** Evidence items that did not fit and were dropped, with their ids. */
  droppedItemIds: string[];
}

/** The complete input to one LLM review call. */
export interface ReviewContext {
  /** The unified diff under review. Always included; never dropped for budget. */
  diff: string;
  evidence: EvidenceItem[];
  budget: ContextBudget;
  meta: {
    repoRoot: string;
    baseRef: string;
    headRef: string;
    /** True when the graph engine ran; false for a diff-only baseline review. */
    graphGrounded: boolean;
  };
  /**
   * True when whole files were omitted from the diff to fit the budget. The model is told
   * in the prompt text as well; this is for the run record, so a thin review can be
   * explained after the fact rather than looking like the change was small.
   */
  truncatedDiff: boolean;
}
