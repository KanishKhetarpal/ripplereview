import { config as readDotenvFile } from 'dotenv';
import { Env, validateEnv } from './env.validation';

/** Read in order; the first file to define a key wins, and a real env var beats both. */
export const ENV_FILES = ['.env.local', '.env'];

/**
 * Validates the environment SYNCHRONOUSLY, at module load, before Nest is involved.
 *
 * `ConfigModule.forRoot()` is an `async static`. Its `validate` hook runs inside that async
 * function, so a bad environment produces a REJECTED PROMISE built while the `@Module`
 * decorator's argument is being evaluated — and nothing awaits it until Nest scans the
 * module graph, several microtasks later. Node drains the queue first, sees a rejection
 * with no handler, and kills the process: exit 1, raw stack, past every try/catch in the
 * CLI, before Nest's own error reporting. Observed, not theorised.
 *
 * Throwing here keeps a configuration error synchronous, catchable, and reportable with
 * the CLI's documented exit code.
 */
export function loadAndValidateEnv(): Env {
  for (const path of ENV_FILES) {
    // override:false matches Nest's own precedence — a real env var beats a file.
    readDotenvFile({ path, override: false, quiet: true });
  }
  return validateEnv(process.env);
}
