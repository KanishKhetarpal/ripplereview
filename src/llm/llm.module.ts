import { Module } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { LLM_PROVIDER, LlmProvider } from './interfaces/llm-provider.interface';
import { LlmService } from './llm.service';
import { EchoLlmProvider } from './providers/echo-llm.provider';

/**
 * Resolves `LLM_PROVIDER` to a concrete client.
 *
 * A vendor that is configured but not yet implemented fails loudly here, at boot. The
 * alternative — silently falling back to the echo stub — would let a run report findings
 * that no model ever produced.
 */
export function selectProvider(config: AppConfigService, echo: EchoLlmProvider): LlmProvider {
  switch (config.providerName) {
    case 'echo':
      return echo;
    case 'openai':
    case 'gemini':
      throw new Error(
        `LLM_PROVIDER="${config.providerName}" is not implemented yet (lands in Phase 2). ` +
          'Use LLM_PROVIDER=echo for the offline stub.',
      );
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
