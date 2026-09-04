import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env, ProviderName } from './env.validation';

/**
 * Typed access to validated configuration. Nothing outside this class reads `process.env`,
 * so every setting has exactly one definition and one default.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  private get<K extends keyof Env>(key: K): Env[K] {
    return this.config.get(key, { infer: true });
  }

  get nodeEnv(): Env['NODE_ENV'] {
    return this.get('NODE_ENV');
  }

  get port(): number {
    return this.get('PORT');
  }

  get providerName(): ProviderName {
    return this.get('LLM_PROVIDER');
  }

  /** Undefined means "the provider's own default model", which the provider records. */
  get model(): string | undefined {
    return this.get('LLM_MODEL');
  }

  get maxOutputTokens(): number {
    return this.get('LLM_MAX_OUTPUT_TOKENS');
  }

  get temperature(): number {
    return this.get('LLM_TEMPERATURE');
  }

  get openaiApiKey(): string | undefined {
    return this.get('OPENAI_API_KEY');
  }

  get googleApiKey(): string | undefined {
    return this.get('GOOGLE_API_KEY');
  }

  get contextTokenBudget(): number {
    return this.get('CONTEXT_TOKEN_BUDGET');
  }

  get blastRadiusMaxHops(): number {
    return this.get('BLAST_RADIUS_MAX_HOPS');
  }

  /** Undefined means runs are not persisted. */
  get databaseUrl(): string | undefined {
    return this.get('DATABASE_URL');
  }

  get githubWebhookSecret(): string | undefined {
    return this.get('GITHUB_WEBHOOK_SECRET');
  }

  get githubToken(): string | undefined {
    return this.get('GITHUB_TOKEN');
  }

  get failOn(): Env['REVIEW_FAIL_ON'] {
    return this.get('REVIEW_FAIL_ON');
  }
}
