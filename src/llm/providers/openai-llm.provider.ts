import { LlmCompletionRequest, LlmCompletionResponse } from '../interfaces/llm-provider.interface';
import { HttpLlmProvider, HttpProviderOptions, pick } from './http-llm.provider';

export const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';

/**
 * OpenAI chat completions.
 *
 * The endpoint and auth header were verified against the live API without a key: the path
 * below answers 401 while a deliberately mistyped one answers 404, which is what proves the
 * path is right rather than merely plausible.
 */
export class OpenAiLlmProvider extends HttpLlmProvider {
  readonly name = 'openai';
  readonly model: string;

  constructor(options: HttpProviderOptions) {
    super(options);
    this.model = options.model || DEFAULT_OPENAI_MODEL;
  }

  protected endpoint(): string {
    return `${this.options.baseUrl ?? 'https://api.openai.com'}/v1/chat/completions`;
  }

  protected headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.options.apiKey}`,
    };
  }

  protected requestBody(request: LlmCompletionRequest): unknown {
    return {
      model: this.model,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
      max_completion_tokens: request.maxOutputTokens,
      temperature: request.temperature,
      // Guarantees syntactically valid JSON. It does NOT guarantee our schema, so the
      // parser and its repair round still run — this only removes the "wrapped the JSON in
      // prose" failure, which is the most common one.
      response_format: { type: 'json_object' },
    };
  }

  protected parseResponse(
    body: unknown,
    latencyMs: number,
  ): Omit<LlmCompletionResponse, 'latencyMs'> {
    const text = pick(body, 'choices', 0, 'message', 'content');
    if (typeof text !== 'string') {
      throw new Error(
        `openai: no message content in response (finish_reason=${String(pick(body, 'choices', 0, 'finish_reason'))})`,
      );
    }

    const inputTokens = numberOr(pick(body, 'usage', 'prompt_tokens'), 0);
    const outputTokens = numberOr(pick(body, 'usage', 'completion_tokens'), 0);

    void latencyMs;
    return {
      text,
      model: typeof pick(body, 'model') === 'string' ? (pick(body, 'model') as string) : this.model,
      usage: {
        inputTokens,
        outputTokens,
        // Prices change and are per-model; guessing one would put an invented number on a
        // run record that later gets reported as a measurement.
        estimatedCostUsd: null,
      },
    };
  }

  protected errorDetail(status: number, rawBody: string): string {
    try {
      const parsed: unknown = JSON.parse(rawBody);
      const message = pick(parsed, 'error', 'message');
      const code = pick(parsed, 'error', 'code');
      if (typeof message === 'string') {
        // `code` is unknown until proven otherwise; String() on an object yields
        // "[object Object]", which is worse than omitting it.
        return typeof code === 'string' ? `${message} (${code})` : message;
      }
    } catch {
      // 404 comes back with an empty body and no content-type at all.
    }
    return rawBody.slice(0, 300) || `no response body (HTTP ${status})`;
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
