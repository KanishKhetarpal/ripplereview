import { Logger } from '@nestjs/common';
import { LlmCompletionRequest, LlmCompletionResponse } from '../interfaces/llm-provider.interface';

export class LlmHttpError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    readonly detail: string,
  ) {
    super(`${provider} returned HTTP ${status}: ${detail}`);
    this.name = 'LlmHttpError';
  }
}

export interface HttpProviderOptions {
  apiKey: string;
  model: string;
  /** Overridable so tests can point the provider at a local server. */
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 2;

/**
 * Shared HTTP behaviour for the vendor providers.
 *
 * `fetch` is used directly rather than a vendor SDK. The interface this satisfies is four
 * lines wide, both APIs are a single POST, and an SDK would bring its own retry policy,
 * its own timeout, and its own opinion about errors — three things this class exists to
 * make identical across vendors, so the eval's "same everything but the context" claim
 * holds.
 */
export abstract class HttpLlmProvider {
  protected readonly logger = new Logger(this.constructor.name);

  constructor(protected readonly options: HttpProviderOptions) {}

  abstract readonly name: string;
  abstract readonly model: string;

  protected abstract endpoint(): string;
  protected abstract headers(): Record<string, string>;
  protected abstract requestBody(request: LlmCompletionRequest): unknown;
  protected abstract parseResponse(
    body: unknown,
    latencyMs: number,
  ): Omit<LlmCompletionResponse, 'latencyMs'>;
  /** Vendor-specific: pull a human-readable reason out of an error payload. */
  protected abstract errorDetail(status: number, rawBody: string): string;

  async complete(request: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const maxRetries = this.options.maxRetries ?? DEFAULT_MAX_RETRIES;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const startedAt = Date.now();
      try {
        const response = await this.post(request);
        const latencyMs = Date.now() - startedAt;
        return { ...this.parseResponse(response, latencyMs), latencyMs };
      } catch (error) {
        lastError = error as Error;
        if (!this.isRetryable(error) || attempt === maxRetries) throw error;

        // Exponential backoff. A 429 or a 503 is the provider asking for time, and
        // hammering it converts a slow review into a failed one.
        const waitMs = 1000 * 2 ** attempt;
        this.logger.warn(
          `${this.name} attempt ${attempt + 1} failed (${lastError.message}); retrying in ${waitMs}ms`,
        );
        await sleep(waitMs);
      }
    }

    throw lastError ?? new Error(`${this.name}: exhausted retries with no error recorded`);
  }

  private async post(request: LlmCompletionRequest): Promise<unknown> {
    const response = await fetch(this.endpoint(), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(this.requestBody(request)),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });

    // Read as text first, always. OpenAI serves its 401 body as `text/plain` — verified
    // against the live API — so a content-type-driven `response.json()` would throw on the
    // one response that actually explains what went wrong.
    const raw = await response.text();

    if (!response.ok) {
      throw new LlmHttpError(this.name, response.status, this.errorDetail(response.status, raw));
    }

    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new LlmHttpError(
        this.name,
        response.status,
        `response was not JSON: ${raw.slice(0, 200)}`,
      );
    }
  }

  /**
   * Only transient conditions are retried.
   *
   * A 401 or a 400 will fail identically on every attempt, and retrying it turns an
   * immediate, clear failure into the same failure three backoffs later.
   */
  protected isRetryable(error: unknown): boolean {
    if (error instanceof LlmHttpError) {
      return error.status === 429 || error.status >= 500;
    }
    // A timeout or a socket error: worth one more try.
    return error instanceof Error && error.name !== 'LlmResponseError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reads a nested field without trusting any of the intermediate shapes. */
export function pick(source: unknown, ...path: (string | number)[]): unknown {
  let current: unknown = source;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}
