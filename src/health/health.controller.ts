import { Controller, Get } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { RunStoreService } from '../db/run-store.service';
import { GitHubClient } from '../github/github-client';
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
    private readonly runs: RunStoreService,
    private readonly github: GitHubClient,
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
        contextAssembler: 'implemented',
        llmAdapter: 'implemented',
        findingParser: 'implemented',
        grounding: 'implemented',
        output: 'implemented',
        persistence: this.runs.enabled ? 'implemented' : 'not-implemented',
        githubWebhook: 'implemented',
        githubReviewPosting: this.github.configured ? 'implemented' : 'not-implemented',
        // Split from the webhook deliberately. The endpoint verifies and acknowledges;
        // nothing dispatches a review yet, and one combined "github: implemented" would
        // report a working integration that stops half way.
        githubReviewDispatch: 'not-implemented',
      },
    };
  }
}
