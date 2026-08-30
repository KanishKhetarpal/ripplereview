import { ChangeImpact } from './change-impact';
import { EvidenceItem } from './evidence';
import { RejectedFinding } from '../grounding';
import { Finding } from './finding';
import { LlmUsage } from '../../llm/interfaces/llm-provider.interface';

/** Everything one review run produced, in the shape the CLI, the API and the DB all use. */
export interface ReviewResult {
  runId: string;
  createdAt: string;
  repo: {
    root: string;
    baseRef: string;
    headRef: string;
  };
  /** False for the diff-only baseline the eval harness compares against. */
  graphGrounded: boolean;
  findings: Finding[];
  /** Findings the grounding guard dropped. Reported, never silently discarded. */
  rejected: RejectedFinding[];
  evidence: EvidenceItem[];
  /** Null on a diff-only run, where no graph was built. */
  impact: ChangeImpact | null;
  llm: {
    provider: string;
    model: string;
    usage: LlmUsage[];
    latencyMs: number;
    attempts: number;
  };
  totalDurationMs: number;
}
