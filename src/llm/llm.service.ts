import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { Finding } from '../core/types/finding';
import { LLM_PROVIDER, LlmProvider, LlmUsage } from './interfaces/llm-provider.interface';
import { parseFindings } from './parsing/finding-parser';

export interface StructuredReviewResult {
  findings: Finding[];
  model: string;
  provider: string;
  /** One entry per model call, including repair attempts — cost is per call, not per review. */
  usage: LlmUsage[];
  totalLatencyMs: number;
  attempts: number;
  /** Populated when a first attempt failed validation and was repaired. */
  repairReasons: string[];
}

export class LlmResponseError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly lastResponse: string,
  ) {
    super(message);
    this.name = 'LlmResponseError';
  }
}

/** How many times a malformed response is sent back for correction before giving up. */
const MAX_REPAIR_ATTEMPTS = 2;

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);

  constructor(
    @Inject(LLM_PROVIDER) private readonly provider: LlmProvider,
    private readonly config: AppConfigService,
  ) {}

  get providerName(): string {
    return this.provider.name;
  }

  /**
   * Asks the model for findings and insists on the schema.
   *
   * A malformed response is not discarded and it is not coerced — it is quoted back with
   * the specific validation problem, which is far more likely to produce valid JSON than a
   * blind retry of the same prompt. Failures are recorded so a provider that needs repairs
   * on every call is visible rather than merely slow.
   */
  async reviewStructured(system: string, user: string): Promise<StructuredReviewResult> {
    const usage: LlmUsage[] = [];
    const repairReasons: string[] = [];
    let totalLatencyMs = 0;
    let prompt = user;
    let lastResponse = '';

    for (let attempt = 1; attempt <= MAX_REPAIR_ATTEMPTS + 1; attempt++) {
      const response = await this.provider.complete({
        system,
        user: prompt,
        maxOutputTokens: this.config.maxOutputTokens,
        temperature: this.config.temperature,
      });

      usage.push(response.usage);
      totalLatencyMs += response.latencyMs;
      lastResponse = response.text;

      const parsed = parseFindings(response.text);
      if (parsed.ok) {
        return {
          findings: parsed.findings,
          model: response.model,
          provider: this.provider.name,
          usage,
          totalLatencyMs,
          attempts: attempt,
          repairReasons,
        };
      }

      repairReasons.push(parsed.reason);
      this.logger.warn(
        `${this.provider.name} response failed validation on attempt ${attempt}: ${parsed.reason}`,
      );
      prompt = `${user}\n\n---\nYour previous reply was rejected.\n${parsed.repairInstruction}`;
    }

    throw new LlmResponseError(
      `${this.provider.name} did not return a schema-valid response after ` +
        `${MAX_REPAIR_ATTEMPTS + 1} attempts: ${repairReasons.join(' | ')}`,
      MAX_REPAIR_ATTEMPTS + 1,
      lastResponse,
    );
  }
}
