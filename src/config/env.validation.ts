import { z } from 'zod';

export const PROVIDER_NAMES = ['echo', 'openai', 'gemini'] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

const optionalString = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value.length > 0, { message: 'must not be blank' })
  .optional();

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),

    LLM_PROVIDER: z.enum(PROVIDER_NAMES).default('echo'),
    LLM_MODEL: optionalString,
    LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(200_000).default(4096),
    LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0),

    OPENAI_API_KEY: optionalString,
    GOOGLE_API_KEY: optionalString,

    CONTEXT_TOKEN_BUDGET: z.coerce.number().int().min(1_000).max(2_000_000).default(60_000),
    BLAST_RADIUS_MAX_HOPS: z.coerce.number().int().min(1).max(10).default(3),

    // Optional. Unset means runs are not persisted, which is the right default for a CLI
    // on a laptop; a malformed value is still an error, because silently not storing runs
    // is exactly what a typo here would look like.
    DATABASE_URL: optionalString.refine(
      (value) => value === undefined || /^postgres(ql)?:\/\//.test(value),
      { message: 'must be a postgres:// or postgresql:// connection string' },
    ),

    // Shared secret for the GitHub webhook. Unset means the endpoint refuses every
    // request rather than accepting unsigned ones.
    GITHUB_WEBHOOK_SECRET: optionalString,
    GITHUB_TOKEN: optionalString,
    // Findings at or above this severity make the CLI exit 1, which is what fails a build.
    REVIEW_FAIL_ON: z.enum(['critical', 'high', 'medium', 'low', 'info', 'never']).default('high'),
  })
  // Fail at boot rather than at the first API call: a run that dies halfway through has
  // already spent time parsing the repo and building the graph.
  .superRefine((env, ctx) => {
    if (env.LLM_PROVIDER === 'openai' && !env.OPENAI_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['OPENAI_API_KEY'],
        message: 'is required when LLM_PROVIDER=openai',
      });
    }
    if (env.LLM_PROVIDER === 'gemini' && !env.GOOGLE_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['GOOGLE_API_KEY'],
        message: 'is required when LLM_PROVIDER=gemini',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/** Nest's ConfigModule `validate` hook. Throws with every problem listed, not just the first. */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (result.success) return result.data;

  const problems = result.error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'} ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${problems}`);
}
