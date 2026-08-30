import { Injectable } from '@nestjs/common';
import {
  LlmCompletionRequest,
  LlmCompletionResponse,
  LlmProvider,
} from '../interfaces/llm-provider.interface';

/**
 * A deterministic offline provider. It makes no network call and has no opinion about
 * code quality: it reflects the evidence ids it was given back as one `info` finding.
 *
 * It exists so the pipeline — assembly, parsing, grounding, rendering — can be exercised
 * in tests and in `ripplereview demo` without a key and without a bill. It must never be
 * used to produce a number that gets reported as a review result.
 */
@Injectable()
export class EchoLlmProvider implements LlmProvider {
  readonly name = 'echo';
  readonly model = 'echo-stub';

  complete(request: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const startedAt = Date.now();
    const evidenceRefs = this.citedEvidenceIds(request.user);
    const file = this.firstFile(request.user);

    const payload = {
      findings: [
        {
          severity: 'info',
          category: 'maintainability',
          file,
          line: 0,
          summary: `Echo provider: received ${evidenceRefs.length} evidence item(s)`,
          rationale:
            'This is the offline stub, not a review. It confirms the prompt reached a ' +
            'provider and that the response round-trips through schema validation.',
          evidenceRefs,
        },
      ],
    };

    const text = JSON.stringify(payload, null, 2);

    return Promise.resolve({
      text,
      model: this.model,
      usage: {
        inputTokens: this.approximateTokens(request.system + request.user),
        outputTokens: this.approximateTokens(text),
        estimatedCostUsd: 0,
      },
      latencyMs: Date.now() - startedAt,
    });
  }

  /** Evidence ids as the assembler writes them into the prompt: `[E12]`. */
  private citedEvidenceIds(prompt: string): string[] {
    const ids = prompt.match(/\[E\d+\]/g) ?? [];
    return [...new Set(ids.map((id) => id.slice(1, -1)))];
  }

  private firstFile(prompt: string): string {
    const match = prompt.match(/[\w./-]+\.[cm]?[jt]sx?/);
    if (!match) return 'unknown';
    // Diff headers read `--- a/src/x.ts` / `+++ b/src/x.ts`; the a/ and b/ prefixes are
    // git's, not part of any repo-relative path.
    return match[0].replace(/^[ab]\//, '');
  }

  /** Rough character-per-token heuristic; only ever used for the stub's own bookkeeping. */
  private approximateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
