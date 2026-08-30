import { describe, expect, it } from 'vitest';
import { AppConfigService } from '../config/app-config.service';
import { LlmResponseError, LlmService } from './llm.service';
import {
  LlmCompletionRequest,
  LlmCompletionResponse,
  LlmProvider,
} from './interfaces/llm-provider.interface';

class ScriptedProvider implements LlmProvider {
  readonly name = 'scripted';
  readonly model = 'scripted-1';
  readonly prompts: string[] = [];

  constructor(private readonly responses: string[]) {}

  complete(request: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    this.prompts.push(request.user);
    const text = this.responses.shift() ?? '';
    return Promise.resolve({
      text,
      model: this.model,
      usage: { inputTokens: 10, outputTokens: 20, estimatedCostUsd: null },
      latencyMs: 5,
    });
  }
}

const config = {
  maxOutputTokens: 1024,
  temperature: 0,
} as AppConfigService;

const validPayload = JSON.stringify({
  findings: [
    {
      severity: 'low',
      category: 'maintainability',
      file: 'src/a.ts',
      line: 1,
      summary: 'ok',
      rationale: 'fine',
      evidenceRefs: [],
    },
  ],
});

describe('LlmService.reviewStructured', () => {
  it('returns findings on a first-attempt valid response', async () => {
    const provider = new ScriptedProvider([validPayload]);
    const service = new LlmService(provider, config);

    const result = await service.reviewStructured('sys', 'user');

    expect(result.findings).toHaveLength(1);
    expect(result.attempts).toBe(1);
    expect(result.repairReasons).toEqual([]);
    expect(provider.prompts).toHaveLength(1);
  });

  it('repairs a malformed first response and reports that it had to', async () => {
    const provider = new ScriptedProvider(['sorry, no JSON here', validPayload]);
    const service = new LlmService(provider, config);

    const result = await service.reviewStructured('sys', 'user');

    expect(result.findings).toHaveLength(1);
    expect(result.attempts).toBe(2);
    expect(result.repairReasons).toHaveLength(1);
    expect(result.repairReasons[0]).toContain('no JSON');
  });

  it('quotes the specific validation problem back to the model', async () => {
    const bad = JSON.stringify({ findings: [{ severity: 'nope' }] });
    const provider = new ScriptedProvider([bad, validPayload]);
    const service = new LlmService(provider, config);

    await service.reviewStructured('sys', 'the original prompt');

    expect(provider.prompts[1]).toContain('the original prompt');
    expect(provider.prompts[1]).toContain('previous reply was rejected');
    expect(provider.prompts[1]).toContain('severity');
  });

  it('accumulates usage across every call, including repairs', async () => {
    const provider = new ScriptedProvider(['garbage', validPayload]);
    const service = new LlmService(provider, config);

    const result = await service.reviewStructured('sys', 'user');

    expect(result.usage).toHaveLength(2);
    expect(result.totalLatencyMs).toBe(10);
  });

  it('gives up after the repair budget instead of retrying forever', async () => {
    const provider = new ScriptedProvider(['no', 'still no', 'nope']);
    const service = new LlmService(provider, config);

    await expect(service.reviewStructured('sys', 'user')).rejects.toBeInstanceOf(LlmResponseError);
    expect(provider.prompts).toHaveLength(3);
  });

  it('surfaces the provider name so a run records which model produced it', async () => {
    const provider = new ScriptedProvider([validPayload]);
    const service = new LlmService(provider, config);

    const result = await service.reviewStructured('sys', 'user');

    expect(result.provider).toBe('scripted');
    expect(result.model).toBe('scripted-1');
    expect(service.providerName).toBe('scripted');
  });
});
