import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.validation';

describe('validateEnv', () => {
  it('applies documented defaults to an empty environment', () => {
    const env = validateEnv({});
    expect(env.LLM_PROVIDER).toBe('echo');
    expect(env.PORT).toBe(3000);
    expect(env.BLAST_RADIUS_MAX_HOPS).toBe(3);
    expect(env.CONTEXT_TOKEN_BUDGET).toBe(60_000);
    expect(env.LLM_TEMPERATURE).toBe(0);
  });

  it('coerces numeric strings, because process.env only holds strings', () => {
    const env = validateEnv({ PORT: '8080', BLAST_RADIUS_MAX_HOPS: '5' });
    expect(env.PORT).toBe(8080);
    expect(env.BLAST_RADIUS_MAX_HOPS).toBe(5);
  });

  it('rejects an unknown provider', () => {
    expect(() => validateEnv({ LLM_PROVIDER: 'llama' })).toThrow(/LLM_PROVIDER/);
  });

  it('requires an OpenAI key when OpenAI is selected', () => {
    expect(() => validateEnv({ LLM_PROVIDER: 'openai' })).toThrow(/OPENAI_API_KEY/);
  });

  it('requires a Google key when Gemini is selected', () => {
    expect(() => validateEnv({ LLM_PROVIDER: 'gemini' })).toThrow(/GOOGLE_API_KEY/);
  });

  it('treats a blank key as missing rather than present', () => {
    expect(() => validateEnv({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: '   ' })).toThrow(
      /OPENAI_API_KEY/,
    );
  });

  it('accepts OpenAI once a key is supplied', () => {
    const env = validateEnv({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test' });
    expect(env.OPENAI_API_KEY).toBe('sk-test');
  });

  it('rejects a hop count outside the supported range', () => {
    expect(() => validateEnv({ BLAST_RADIUS_MAX_HOPS: '0' })).toThrow(/BLAST_RADIUS_MAX_HOPS/);
    expect(() => validateEnv({ BLAST_RADIUS_MAX_HOPS: '99' })).toThrow(/BLAST_RADIUS_MAX_HOPS/);
  });

  it('lists every problem at once instead of failing on the first', () => {
    const call = (): unknown => validateEnv({ LLM_PROVIDER: 'openai', PORT: '-1' });
    expect(call).toThrow(/PORT/);
    expect(call).toThrow(/OPENAI_API_KEY/);
  });
});
