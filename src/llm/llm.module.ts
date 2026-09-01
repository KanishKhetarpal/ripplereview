import { Module } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { LLM_PROVIDER, LlmProvider } from './interfaces/llm-provider.interface';
import { LlmService } from './llm.service';
import { EchoLlmProvider } from './providers/echo-llm.provider';
import { GeminiLlmProvider } from './providers/gemini-llm.provider';
import { OpenAiLlmProvider } from './providers/openai-llm.provider';

/**
 * Resolves `LLM_PROVIDER` to a concrete client.
 *
 * A missing key is already refused by env validation at boot, so by the time this runs the
 * selected vendor's key is present. Falling back to the echo stub for any reason would let
 * a run report findings that no model ever produced.
 */
export function selectProvider(config: AppConfigService, echo: EchoLlmProvider): LlmProvider {
  switch (config.providerName) {
    case 'echo':
      return echo;
    case 'openai':
      return new OpenAiLlmProvider({
        apiKey: config.openaiApiKey as string,
        model: config.model ?? '',
      });
    case 'gemini':
      return new GeminiLlmProvider({
        apiKey: config.googleApiKey as string,
        model: config.model ?? '',
      });
  }
}

@Module({
  providers: [
    EchoLlmProvider,
    {
      provide: LLM_PROVIDER,
      useFactory: selectProvider,
      inject: [AppConfigService, EchoLlmProvider],
    },
    LlmService,
  ],
  exports: [LLM_PROVIDER, LlmService],
})
export class LlmModule {}
