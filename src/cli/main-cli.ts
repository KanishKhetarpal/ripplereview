#!/usr/bin/env node
import 'reflect-metadata';
import { Command } from 'commander';
import { LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppConfigService } from '../config/app-config.service';
import { ReviewResult } from '../core/types/review-result';
import { ReportRenderer } from '../output/report-renderer';
import { ReviewService } from '../review/review.service';

/**
 * Exit codes are part of the contract — CI reads them.
 *   0  the review ran and nothing blocking was found
 *   1  the review ran and reported blocking findings (wired with severity gating in Phase 4)
 *   2  the review could not run
 */
const EXIT_OK = 0;
const EXIT_ERROR = 2;

interface GlobalOptions {
  json?: boolean;
  color?: boolean;
  verbose?: boolean;
}

async function withApp<T>(
  options: GlobalOptions,
  work: (ctx: {
    reviews: ReviewService;
    renderer: ReportRenderer;
    config: AppConfigService;
  }) => Promise<T>,
): Promise<T> {
  // JSON output must be the only thing on stdout, or a consumer piping it gets Nest's
  // bootstrap banner mixed into the payload.
  const logger: LogLevel[] = options.verbose
    ? ['error', 'warn', 'log', 'debug']
    : options.json
      ? ['error']
      : ['error', 'warn'];

  // Imported here, not at module scope: `@Module` decorators execute on require, and
  // ConfigModule validates the environment as they do. A static import would throw the
  // config error past this try/catch and out of the process as a stack trace.
  const { AppModule } = await import('../app.module');
  // abortOnError defaults to TRUE, which makes Nest log the failure itself and call
  // process.exit(1) — bypassing this function's caller and the documented exit codes.
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger,
    abortOnError: false,
  });
  try {
    return await work({
      reviews: app.get(ReviewService),
      renderer: app.get(ReportRenderer),
      config: app.get(AppConfigService),
    });
  } finally {
    await app.close();
  }
}

function emit(result: ReviewResult, renderer: ReportRenderer, options: GlobalOptions): void {
  if (options.json) {
    process.stdout.write(`${renderer.renderJson(result)}\n`);
    return;
  }
  const color = options.color !== false && process.stdout.isTTY === true;
  process.stdout.write(`${renderer.renderText(result, { color })}\n`);
}

function fail(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`ripplereview: ${message}\n`);
  process.exit(EXIT_ERROR);
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('ripplereview')
    .description('Graph-grounded AI code review: blast-radius context, not just a diff.')
    .version('0.1.0')
    .option('--json', 'emit machine-readable JSON on stdout')
    .option('--no-color', 'disable ANSI colour')
    .option('-v, --verbose', 'log pipeline progress to stderr');

  program
    .command('review')
    .argument('<repo>', 'path to the repository working tree')
    .option('--base <ref>', 'base git ref', 'HEAD~1')
    .option('--head <ref>', 'head git ref', 'HEAD')
    .option('--diff-only', 'skip the graph engine (the eval baseline)', false)
    .description('review the change between two refs')
    .action(async (repo: string, cmd: { base: string; head: string; diffOnly: boolean }) => {
      const globals = program.opts<GlobalOptions>();
      try {
        await withApp(globals, async ({ reviews, renderer }) => {
          const result = await reviews.run({
            repoPath: repo,
            baseRef: cmd.base,
            headRef: cmd.head,
            diffOnly: cmd.diffOnly,
          });
          emit(result, renderer, globals);
        });
        process.exit(EXIT_OK);
      } catch (error) {
        fail(error);
      }
    });

  program
    .command('demo')
    .description('run the implemented pipeline stages over a fixture change')
    .action(async () => {
      const globals = program.opts<GlobalOptions>();
      try {
        await withApp(globals, async ({ reviews, renderer }) => {
          const result = await reviews.runDemo();
          emit(result, renderer, globals);
        });
        process.exit(EXIT_OK);
      } catch (error) {
        fail(error);
      }
    });

  program
    .command('config')
    .description('print the resolved configuration')
    .action(async () => {
      const globals = program.opts<GlobalOptions>();
      try {
        await withApp(globals, ({ config }) => {
          const resolved = {
            nodeEnv: config.nodeEnv,
            llmProvider: config.providerName,
            llmModel: config.model ?? '(provider default)',
            contextTokenBudget: config.contextTokenBudget,
            blastRadiusMaxHops: config.blastRadiusMaxHops,
          };
          process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`);
          return Promise.resolve();
        });
        process.exit(EXIT_OK);
      } catch (error) {
        fail(error);
      }
    });

  return program;
}

if (require.main === module) {
  buildProgram().parseAsync(process.argv).catch(fail);
}
