/**
 * The only surface the reviewer sees. Swapping vendors must never require touching the
 * context assembler, the prompt, or the parser — the thesis is "same model, better
 * context", and that comparison is meaningless if the model is welded into the pipeline.
 */

export interface LlmCompletionRequest {
  system: string;
  user: string;
  maxOutputTokens: number;
  temperature: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  /** Null when the provider does not report cost; never guessed. */
  estimatedCostUsd: number | null;
}

export interface LlmCompletionResponse {
  text: string;
  model: string;
  usage: LlmUsage;
  latencyMs: number;
}

export interface LlmProvider {
  /** Registry key, matched against `LLM_PROVIDER`. */
  readonly name: string;
  /** The concrete model this instance talks to, recorded on every run. */
  readonly model: string;
  complete(request: LlmCompletionRequest): Promise<LlmCompletionResponse>;
}

export const LLM_PROVIDER = Symbol('LLM_PROVIDER');
