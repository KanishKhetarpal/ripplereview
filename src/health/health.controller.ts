import { Controller, Get } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { LlmService } from '../llm/llm.service';

export interface HealthReport {
  status: 'ok';
  version: string;
  nodeEnv: string;
  llmProvider: string;
  /** Which pipeline stages are actually implemented, so nothing is assumed. */
  stages: Record<string, 'implemented' | 'not-implemented'>;
}

@Controller('health')
export class HealthController {
  constructor(
    private readonly config: AppConfigService,
    private readonly llm: LlmService,
  ) {}

  @Get()
  check(): HealthReport {
    return {
      status: 'ok',
      version: process.env.npm_package_version ?? '0.1.0',
      nodeEnv: this.config.nodeEnv,
      llmProvider: this.llm.providerName,
      stages: {
        ingest: 'implemented',
        graph: 'implemented',
        contextAssembler: 'not-implemented',
        llmAdapter: 'implemented',
        findingParser: 'implemented',
        grounding: 'implemented',
        output: 'implemented',
        persistence: 'not-implemented',
        github: 'not-implemented',
      },
    };
  }
}
