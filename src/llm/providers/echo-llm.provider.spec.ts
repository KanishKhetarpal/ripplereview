import { describe, expect, it } from 'vitest';
import { parseFindings } from '../parsing/finding-parser';
import { EchoLlmProvider } from './echo-llm.provider';

const request = {
  system: 'you are a reviewer',
  user: '## DIFF\nsrc/pricing/price.service.ts\n## EVIDENCE\n[E1] a calls b\n[E2] a <-> b\n[E1] again',
  maxOutputTokens: 1024,
  temperature: 0,
};

describe('EchoLlmProvider', () => {
  it('produces a response that survives the real parser', async () => {
    const response = await new EchoLlmProvider().complete(request);
    const parsed = parseFindings(response.text);
    expect(parsed.ok).toBe(true);
  });

  it('echoes back the distinct evidence ids it was given', async () => {
    const response = await new EchoLlmProvider().complete(request);
    const parsed = parseFindings(response.text);
    if (!parsed.ok) throw new Error('expected the stub to parse');
    expect(parsed.findings[0].evidenceRefs).toEqual(['E1', 'E2']);
  });

  it('is deterministic — the same request yields the same findings', async () => {
    const provider = new EchoLlmProvider();
    const a = await provider.complete(request);
    const b = await provider.complete(request);
    expect(JSON.parse(a.text)).toEqual(JSON.parse(b.text));
  });

  it('reports zero cost, because it never calls anything', async () => {
    const response = await new EchoLlmProvider().complete(request);
    expect(response.usage.estimatedCostUsd).toBe(0);
    expect(response.model).toBe('echo-stub');
  });
});

describe('EchoLlmProvider file attribution', () => {
  it('strips the git a/ and b/ prefixes from a diff header path', async () => {
    const response = await new EchoLlmProvider().complete({
      ...request,
      user: '--- a/src/pricing/price.service.ts\n+++ b/src/pricing/price.service.ts',
    });
    const parsed = parseFindings(response.text);
    if (!parsed.ok) throw new Error('expected the stub to parse');
    expect(parsed.findings[0].file).toBe('src/pricing/price.service.ts');
  });

  it('falls back to "unknown" when the prompt names no file', async () => {
    const response = await new EchoLlmProvider().complete({ ...request, user: 'no paths here' });
    const parsed = parseFindings(response.text);
    if (!parsed.ok) throw new Error('expected the stub to parse');
    expect(parsed.findings[0].file).toBe('unknown');
  });
});
