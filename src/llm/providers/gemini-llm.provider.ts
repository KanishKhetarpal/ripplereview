import { LlmCompletionRequest, LlmCompletionResponse } from '../interfaces/llm-provider.interface';
import { HttpLlmProvider, HttpProviderOptions, pick } from './http-llm.provider';

export const DEFAULT_GEMINI_MODEL = 'gemini-2.0-flash';

/**
 * Google Gemini via the Generative Language API.
 *
 * Verified against the live API without a key, and it behaves differently from OpenAI in a
 * way worth knowing: an invalid key comes back as **HTTP 400, not 401**, with
 * `error.status = "INVALID_ARGUMENT"` and a nested `reason: "API_KEY_INVALID"`. So "400
 * means we sent something malformed" is wrong here, and code that classified errors by
 * status alone would report a bad key as a bug in the request builder.
 *
 * Key travels in the `x-goog-api-key` header rather than a query parameter, so it cannot
 * end up in a proxy log or an error message that quotes the URL.
 */
export class GeminiLlmProvider extends HttpLlmProvider {
  readonly name = 'gemini';
  readonly model: string;

  constructor(options: HttpProviderOptions) {
    super(options);
    this.model = options.model || DEFAULT_GEMINI_MODEL;
  }

  protected endpoint(): string {
    const base = this.options.baseUrl ?? 'https://generativelanguage.googleapis.com';
    return `${base}/v1beta/models/${this.model}:generateContent`;
  }

  protected headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-goog-api-key': this.options.apiKey,
    };
  }

  protected requestBody(request: LlmCompletionRequest): unknown {
    return {
      // Gemini has no system role in `contents`; the system prompt is its own field.
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [{ role: 'user', parts: [{ text: request.user }] }],
      generationConfig: {
        maxOutputTokens: request.maxOutputTokens,
        temperature: request.temperature,
        responseMimeType: 'application/json',
      },
    };
  }

  protected parseResponse(
    body: unknown,
    latencyMs: number,
  ): Omit<LlmCompletionResponse, 'latencyMs'> {
    const text = pick(body, 'candidates', 0, 'content', 'parts', 0, 'text');

    if (typeof text !== 'string') {
      // A blocked or truncated candidate has no text but does say why. Reporting the
      // reason beats reporting "no content", which sends the reader to the wrong place.
      const finish = pick(body, 'candidates', 0, 'finishReason');
      const blocked = pick(body, 'promptFeedback', 'blockReason');
      throw new Error(
        `gemini: no text in response (finishReason=${String(finish)}, blockReason=${String(blocked)})`,
      );
    }

    void latencyMs;
    return {
      text,
      model: this.model,
      usage: {
        inputTokens: numberOr(pick(body, 'usageMetadata', 'promptTokenCount'), 0),
        outputTokens: numberOr(pick(body, 'usageMetadata', 'candidatesTokenCount'), 0),
        estimatedCostUsd: null,
      },
    };
  }

  protected errorDetail(status: number, rawBody: string): string {
    try {
      const parsed: unknown = JSON.parse(rawBody);
      const message = pick(parsed, 'error', 'message');
      const reason = pick(parsed, 'error', 'details', 0, 'reason');
      if (typeof message === 'string') {
        return typeof reason === 'string' ? `${message} (${reason})` : message;
      }
    } catch {
      // Fall through to the raw body.
    }
    return rawBody.slice(0, 300) || `no response body (HTTP ${status})`;
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
